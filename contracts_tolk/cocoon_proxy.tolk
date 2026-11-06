import "@stdlib/gas-payments"
import "opcodes"
import "errors"
import "messages"
import "storage"

// === Proxy-specific Message Types ===

// Text command messages
struct (0x00000000) TextCmd {
    action: uint8  // 99 = "c", 119 = "w"
}

// Signed message payloads
type SignedProxyPayload = CloseRequestPayload | CloseCompleteRequestPayload

// Signed messages (outer envelope - empty, just for opcode matching)
struct (0x636a4391) ExtProxyCloseRequestSigned {
    rest: RemainingBitsAndRefs
}

struct (0xe511abc7) ExtProxyCloseCompleteRequestSigned {
    rest: RemainingBitsAndRefs
}

type SignedProxyMessage = ExtProxyCloseRequestSigned | ExtProxyCloseCompleteRequestSigned

type ClientProxyPayload = ClientProxyTopUp | ClientProxyRegister | ClientProxyRefundGranted | ClientProxyRefundForce

type WorkerProxyPayload = WorkerProxyPayoutRequest

// All message types that can be directly matched
type ProxyMessage =
    | TextCmd
    | ExtProxyCloseRequestSigned
    | ExtProxyCloseCompleteRequestSigned
    | ExtProxyPayoutRequest
    | ExtProxyIncreaseStake
    | OwnerProxyClose
    | WorkerProxyRequest
    | ClientProxyRequest

// === Helper Functions ===

fun ProxyStorage.close(mutate self, queryId: uint64, sendExcessesTo: address, toLeaveOnBalance: coins) {
    if (self.state == proxy_state_normal) {
        reserveToncoinsOnBalance(toLeaveOnBalance, 0);
        sendExcesses(sendExcessesTo, queryId);

        self.state = proxy_state_closing;
        // balance and stake remain unchanged
    } else if (self.state == proxy_state_closing) {
        reserveToncoinsOnBalance(toLeaveOnBalance - self.balance - self.stake, 0);
        sendPayout(self.ownerAddress, self.balance + self.stake, queryId, SEND_MODE_PAY_FEES_SEPARATELY);
        sendExcesses(sendExcessesTo, queryId);

        self.state = proxy_state_closed;
        self.balance = 0;
        self.stake = 0;
    } else {
        throw ERROR_CLOSED;
    }
}

// === Message Handlers ===

fun ProxyStorage.handleSignedProxyMessage(mutate self, inBody: slice, inValueCoins: coins, toLeaveOnBalance: coins, proxyPublicKey: int) {
    assert (COMMISSION_ESTIMATE <= inValueCoins) throw ERROR_LOW_MSG_VALUE;
    val signedMsg = SignedMessage.fromSlice(inBody);
    signedMsg.verify(proxyPublicKey);

    // Match on inner payload type
    val payload = SignedProxyPayload.fromCell(signedMsg.signedDataCell);

    match (payload) {
        CloseRequestPayload => {
            assert (self.state == proxy_state_normal) throw ERROR_CLOSED;
            assert (payload.expectedMyAddress == contract.getAddress()) throw ERROR_EXPECTED_MY_ADDRESS;

            self.close(signedMsg.queryId, signedMsg.sendExcessesTo, toLeaveOnBalance);
        },
        CloseCompleteRequestPayload => {
            assert (self.state == proxy_state_closing) throw ERROR_CLOSED;
            assert (payload.expectedMyAddress == contract.getAddress()) throw ERROR_EXPECTED_MY_ADDRESS;

            self.close(signedMsg.queryId, signedMsg.sendExcessesTo, toLeaveOnBalance);
        }
    }
}

fun ProxyStorage.handleWorkerProxyRequest(mutate self, msg: WorkerProxyRequest, senderAddress: address, toLeaveOnBalance: coins) {
    if (msg.payload is null) {
        return; // No payload, nothing to do
    }

    // Verify sender is the correct worker contract
    val params = self.params.load();
    val workerParams = params.withoutCode();

    val calculatedWorkerAddress = calculateContractAddress(
        params.workerScCode!,
        WorkerStorage {
            ownerAddress: msg.ownerAddress,
            proxyAddress: contract.getAddress(),
            proxyPublicKey: self.proxyPublicKey,
            state: worker_state_normal,
            tokens: 0,
            params: workerParams.toCell(),
        }.toCell()
    );

    assert (senderAddress == calculatedWorkerAddress) throw ERROR_CONTRACT_ADDRESS_MISMATCH;

    val innerMsg = lazy WorkerProxyPayload.fromCell(msg.payload);

    match (innerMsg) {
        WorkerProxyPayoutRequest => {
            assert (self.state != proxy_state_closed) throw ERROR_CLOSED;
            self.balance = self.balance + innerMsg.proxyPart;

            reserveToncoinsOnBalance(toLeaveOnBalance - innerMsg.workerPart, 0);
            sendPayout(msg.ownerAddress, innerMsg.workerPart, msg.queryId, SEND_MODE_PAY_FEES_SEPARATELY);

            sendExcesses(innerMsg.sendExcessesTo, msg.queryId);
        }
    }
}

fun ProxyStorage.handleClientProxyRequest(mutate self, msg: ClientProxyRequest, senderAddress: address, toLeaveOnBalance: coins) {
    if (msg.payload is null) {
        return; // No payload, nothing to do
    }

    // Verify sender is the correct client contract
    val params = self.params.load();
    val clientCode = params.clientScCode!;
    val clientParams = params.withoutCode();

    val clientData = ClientStorage {
        state: client_state_normal,
        balance: 0,
        stake: clientParams.minClientStake,
        tokensUsed: 0,
        unlockTs: 0,
        secretHash: 0,
        constDataRef: ClientConstData {
            ownerAddress: msg.ownerAddress,
            proxyAddress: contract.getAddress(),
            proxyPublicKey: self.proxyPublicKey
        }.toCell(),
        params: clientParams.toCell(),
    }.toCell();
    val calculatedClientAddress = calculateContractAddress(clientCode, clientData);

    assert (senderAddress == calculatedClientAddress) throw ERROR_CONTRACT_ADDRESS_MISMATCH;

    val innerMsg = lazy ClientProxyPayload.fromCell(msg.payload);

    match (innerMsg) {
        ClientProxyTopUp => {
            reserveToncoinsOnBalance(toLeaveOnBalance + innerMsg.topUpCoins, 0);

            sendExcesses(innerMsg.sendExcessesTo, msg.queryId);
        },
        ClientProxyRegister => {
            return; // do not check, nothing to do here
        },
        ClientProxyRefundGranted => {
            reserveToncoinsOnBalance(toLeaveOnBalance - innerMsg.coins, 0);
            sendPayout(msg.ownerAddress, innerMsg.coins, msg.queryId, SEND_MODE_PAY_FEES_SEPARATELY);

            sendExcesses(innerMsg.sendExcessesTo, msg.queryId);
        },
        ClientProxyRefundForce => {
            var coinsToRefund = innerMsg.coins;
            if (self.state != proxy_state_closed) {
              if (coinsToRefund > self.stake) {
                  coinsToRefund = self.stake;
              }
              self.stake = self.stake - coinsToRefund;
            }

            reserveToncoinsOnBalance(toLeaveOnBalance - coinsToRefund, 0);
            sendPayout(msg.ownerAddress, coinsToRefund, msg.queryId, SEND_MODE_PAY_FEES_SEPARATELY);

            // The part not covered by the stake stays recoverable via a signed refund grant
            val shortfall = innerMsg.coins - coinsToRefund;
            if (shortfall > 0) {
                createMessage({
                    bounce: BounceMode.Only256BitsOfBody,
                    dest: senderAddress,
                    value: STORAGE_ESTIMATE,
                    body: ProxyClientRefundShortfall {
                        queryId: msg.queryId,
                        coins: shortfall
                    }
                }).send(SEND_MODE_PAY_FEES_SEPARATELY);
            }

            sendExcesses(innerMsg.sendExcessesTo, msg.queryId);
        }
    }
}

// === Main Message Handler ===

fun onInternalMessage(in: InMessage) {
    if (in.body.isEmpty()) {
        return;
    }

    val toLeaveOnBalance = max(
        contract.getOriginalBalance() - in.valueCoins + contract.getStorageDuePayment(),
        STORAGE_ESTIMATE
    );

    val op = in.body.preloadUint(32);
    if (op == OP_DO_NOT_PROCESS) {
        return;
    }

    var storage = lazy ProxyStorage.load();

    // Match on all message types
    val msg = lazy ProxyMessage.fromSlice(in.body);

    match (msg) {
        TextCmd => {
            match (msg.action) {
                99 => {
                    // "c" - close
                    assert (COMMISSION_ESTIMATE <= in.valueCoins) throw ERROR_LOW_MSG_VALUE;
                    assert (storage.state == proxy_state_normal) throw ERROR_CLOSED;
                    assert (in.senderAddress == storage.ownerAddress) throw ERROR_EXPECTED_MESSAGE_FROM_OWNER;

                    storage.close(0, storage.ownerAddress, toLeaveOnBalance);
                },
                119 => {
                    // "w" - withdraw
                    assert (COMMISSION_ESTIMATE <= in.valueCoins) throw ERROR_LOW_MSG_VALUE;
                    assert (storage.state != proxy_state_closed) throw ERROR_CLOSED;
                    assert (in.senderAddress == storage.ownerAddress) throw ERROR_EXPECTED_MESSAGE_FROM_OWNER;

                    reserveToncoinsOnBalance(toLeaveOnBalance - storage.balance, 0);

                    storage.balance = 0;
                    sendPayout(storage.ownerAddress, 0, 0, SEND_MODE_CARRY_ALL_BALANCE);
                },
                else => {
                    throw ERROR_UNKNOWN_TEXT_OP;
                }
            }

            storage.save();
            return;

        }
        ExtProxyCloseRequestSigned => {
            storage.handleSignedProxyMessage(in.body, in.valueCoins, toLeaveOnBalance, storage.proxyPublicKey);
        },
        ExtProxyCloseCompleteRequestSigned => {
            storage.handleSignedProxyMessage(in.body, in.valueCoins, toLeaveOnBalance, storage.proxyPublicKey);
        },
        WorkerProxyRequest => {
            storage.handleWorkerProxyRequest(msg, in.senderAddress, toLeaveOnBalance);
        },
        ClientProxyRequest => {
            storage.handleClientProxyRequest(msg, in.senderAddress, toLeaveOnBalance);
        },
        ExtProxyPayoutRequest => {
            assert (COMMISSION_ESTIMATE <= in.valueCoins) throw ERROR_LOW_MSG_VALUE;
            assert (storage.state != proxy_state_closed) throw ERROR_CLOSED;

            reserveToncoinsOnBalance(toLeaveOnBalance - storage.balance, 0);
            sendPayout(storage.ownerAddress, storage.balance, msg.queryId, SEND_MODE_PAY_FEES_SEPARATELY);

            storage.balance = 0;
            sendExcesses(msg.sendExcessesTo, msg.queryId);
        },
        ExtProxyIncreaseStake => {
            assert (COMMISSION_ESTIMATE + msg.grams <= in.valueCoins) throw ERROR_LOW_MSG_VALUE;
            assert (storage.state != proxy_state_closed) throw ERROR_CLOSED;

            storage.stake = storage.stake + msg.grams;
            reserveToncoinsOnBalance(toLeaveOnBalance + msg.grams, 0);

            sendExcesses(msg.sendExcessesTo, msg.queryId);
        },
        OwnerProxyClose => {
            assert (COMMISSION_ESTIMATE <= in.valueCoins) throw ERROR_LOW_MSG_VALUE;
            assert (storage.state == proxy_state_normal) throw ERROR_CLOSED;
            assert (in.senderAddress == storage.ownerAddress) throw ERROR_EXPECTED_MESSAGE_FROM_OWNER;

            storage.close(msg.queryId, msg.sendExcessesTo, toLeaveOnBalance);
        }
    }

    storage.save();
}

// === Get Methods ===

get fun get_cocoon_proxy_data(): (address, int, address, int, coins, coins, int, int, int, coins, coins, int) {
    var storage = ProxyStorage.load();
    val params = storage.params.load();
    return (
        storage.ownerAddress,
        storage.proxyPublicKey,
        storage.rootAddress,
        storage.state,
        storage.balance,
        storage.stake,
        storage.unlockTs,
        params.pricePerToken,
        params.workerFeePerToken,
        params.minProxyStake,
        params.minClientStake,
        params.paramsVersion
    );
}
