// Client refund paths when the proxy contract is under-staked.
// Reproduces TelegramMessenger/cocoon#77 and covers the shortfall fix.
//
// Mainnet context (both public proxy contracts, read on 2026-11-05 with get_cocoon_proxy_data):
// stake = 0 while min_proxy_stake = 15 TON. min_proxy_stake is stored in params but never enforced,
// so ClientProxyRefundForce, which is capped by the proxy stake, pays the client nothing.

import { Blockchain, SandboxContract, TreasuryContract, BlockchainTransaction, internal } from '@ton/sandbox';
import { beginCell, Cell, toNano } from '@ton/core';
import { compile } from '@ton/blueprint';
import '@ton/test-utils';
import { CocoonProxy } from '../wrappers/CocoonProxy';
import { CocoonClient } from '../wrappers/CocoonClient';
import { CocoonParams, cocoonParamsToCell } from '../wrappers/CocoonRoot';
import { TestKeyPairs, TestConstants, createDefaultParams } from './helpers/fixtures';

const OP_PROXY_CLIENT_REFUND_SHORTFALL = 0x42c95b27;
const OP_OWNER_CLIENT_TOP_UP_REOPEN = 0x29111ceb;

const PRICE_PER_TOKEN = toNano('0.001');
const MIN_STAKE = toNano('15');
const CLIENT_DELAY = 3600;

describe('Client refund with under-staked proxy (cocoon#77)', () => {
    let proxyCode: Cell;
    let clientCode: Cell;
    let paramsWithCodes: Cell;
    let paramsWithoutCodes: Cell;
    const proxyKeyPair = TestKeyPairs.PROXY_KEYPAIR;
    const proxyPublicKey = BigInt('0x' + proxyKeyPair.publicKey.toString('hex'));

    beforeAll(async () => {
        proxyCode = await compile('CocoonProxy');
        clientCode = await compile('CocoonClient');
        const base: CocoonParams = createDefaultParams({
            price_per_token: PRICE_PER_TOKEN,
            min_proxy_stake: MIN_STAKE,
            min_client_stake: MIN_STAKE,
            client_delay_before_close: CLIENT_DELAY,
        });
        paramsWithCodes = cocoonParamsToCell({ ...base, client_sc_code: clientCode });
        paramsWithoutCodes = cocoonParamsToCell({ ...base, proxy_sc_code: null, worker_sc_code: null, client_sc_code: null });
    });

    let blockchain: Blockchain;
    let proxyOwner: SandboxContract<TreasuryContract>;
    let clientOwner: SandboxContract<TreasuryContract>;
    let operator: SandboxContract<TreasuryContract>;
    let proxy: SandboxContract<CocoonProxy>;
    let client: SandboxContract<CocoonClient>;

    async function setup(proxyStake: bigint, topUp: bigint = MIN_STAKE) {
        blockchain = await Blockchain.create();
        blockchain.now = 1_760_000_000;
        proxyOwner = await blockchain.treasury('proxyOwner');
        clientOwner = await blockchain.treasury('clientOwner');
        operator = await blockchain.treasury('operator');
        const root = await blockchain.treasury('root');

        proxy = blockchain.openContract(
            CocoonProxy.createFromConfig(
                {
                    ownerAddress: proxyOwner.address,
                    proxyPublicKey,
                    rootAddress: root.address,
                    state: TestConstants.STATE_NORMAL,
                    balance: 0n,
                    stake: proxyStake,
                    unlockTs: 0,
                    params: paramsWithCodes,
                },
                proxyCode,
            ),
        );
        await proxy.sendDeploy(proxyOwner.getSender(), proxyStake + toNano('1'));

        client = blockchain.openContract(
            CocoonClient.createFromConfig(
                {
                    ownerAddress: clientOwner.address,
                    proxyAddress: proxy.address,
                    proxyPublicKey,
                    state: TestConstants.STATE_NORMAL,
                    balance: 0n,
                    stake: MIN_STAKE,
                    tokensUsed: 0n,
                    unlockTs: 0,
                    secretHash: 0n,
                    params: paramsWithoutCodes,
                },
                clientCode,
            ),
        );
        await client.sendDeploy(clientOwner.getSender(), toNano('1'));

        const r = await client.sendExtTopUp(clientOwner.getSender(), topUp + toNano('1'), topUp, clientOwner.address);
        expect(r.transactions).toHaveTransaction({ from: client.address, to: proxy.address, success: true });
        expect((await client.getData()).balance).toBe(topUp);
    }

    function payoutsToOwner(txs: BlockchainTransaction[]): bigint[] {
        return txs
            .filter((t) => {
                const m = t.inMessage;
                if (!m || m.info.type !== 'internal') return false;
                if (!m.info.src.equals(proxy.address) || !m.info.dest.equals(clientOwner.address)) return false;
                const s = m.body.beginParse();
                return s.remainingBits >= 32 && s.loadUint(32) === TestConstants.OP_PAYOUT;
            })
            .map((t) => (t.inMessage!.info as { value: { coins: bigint } }).value.coins);
    }

    async function closeAndForce() {
        await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);
        expect((await client.getData()).state).toBe(TestConstants.STATE_CLOSING);
        blockchain.now! += CLIENT_DELAY + 1;
        return await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);
    }

    async function grant(newTokensUsed: bigint, queryId = 77) {
        return await client.sendGrantRefundRequest(
            operator.getSender(),
            queryId,
            newTokensUsed,
            client.address,
            operator.address,
            proxyKeyPair,
            toNano('1'),
        );
    }

    describe('current behaviour (documented, unchanged by the fix)', () => {
        it('closing notice carries 1 nanoton and is a no-op for the proxy contract', async () => {
            await setup(0n);
            const before = await proxy.getData();
            const r = await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);

            const notice = r.transactions.find((t) => t.inMessage?.info.dest?.toString() === proxy.address.toString());
            expect(notice).toBeDefined();
            expect((notice!.inMessage!.info as { value: { coins: bigint } }).value.coins).toBe(1n);
            const d = notice!.description;
            expect(d.type === 'generic' && d.computePhase.type === 'skipped' && d.computePhase.reason).toBe('no-gas');

            // The proxy contract ignores payload-less ClientProxyRequest by design; the off-chain
            // proxy runner is the party that must react to the closing state.
            const after = await proxy.getData();
            expect([after.state, after.balance, after.stake]).toEqual([before.state, before.balance, before.stake]);
            expect((await client.getData()).state).toBe(TestConstants.STATE_CLOSING);
        });

        it('a signed grant while closing returns the full balance', async () => {
            await setup(0n);
            await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);
            const r = await grant(0n);
            expect(payoutsToOwner(r.transactions)).toEqual([MIN_STAKE]);
            const c = await client.getData();
            expect(c.state).toBe(TestConstants.STATE_CLOSED);
            expect(c.balance).toBe(0n);
        });

        it('forced close against a zero-stake proxy pays 0 (mainnet proxy state)', async () => {
            await setup(0n);
            const r = await closeAndForce();
            expect(payoutsToOwner(r.transactions)).toEqual([0n]);
            expect((await client.getData()).state).toBe(TestConstants.STATE_CLOSED);
        });

        it('forced close against a staked proxy is capped by the proxy stake', async () => {
            await setup(toNano('5'));
            const r = await closeAndForce();
            expect(payoutsToOwner(r.transactions)).toEqual([toNano('5')]);
            expect((await proxy.getData()).stake).toBe(0n);
        });

        it('owner_client_top_up_reopen (0x29111ceb) is listed in opcodes but not handled', async () => {
            await setup(0n);
            const r = await clientOwner.send({
                to: client.address,
                value: toNano('1'),
                body: beginCell().storeUint(OP_OWNER_CLIENT_TOP_UP_REOPEN, 32).storeUint(0, 64).endCell(),
            });
            expect(r.transactions).toHaveTransaction({ to: client.address, success: false });
        });
    });

    describe('shortfall fix', () => {
        it('forced close records the unpaid remainder on the client', async () => {
            await setup(0n);
            await closeAndForce();
            const c = await client.getData();
            expect(c.state).toBe(TestConstants.STATE_CLOSED);
            expect(c.balance).toBe(MIN_STAKE);
        });

        it('a signed grant after forced close returns the remainder exactly once', async () => {
            await setup(0n);
            await closeAndForce();

            const r1 = await grant(0n);
            expect(payoutsToOwner(r1.transactions)).toEqual([MIN_STAKE]);
            expect((await client.getData()).balance).toBe(0n);

            const r2 = await grant(0n, 78);
            expect(r2.transactions).toHaveTransaction({
                to: client.address,
                success: false,
                exitCode: TestConstants.ERROR_CLOSED,
            });
            expect(payoutsToOwner(r2.transactions)).toEqual([]);
        });

        it('partial proxy stake: stake pays first, grant pays the rest, total equals the balance', async () => {
            await setup(toNano('5'));
            const r1 = await closeAndForce();
            expect(payoutsToOwner(r1.transactions)).toEqual([toNano('5')]);
            expect((await client.getData()).balance).toBe(toNano('10'));

            const r2 = await grant(0n);
            expect(payoutsToOwner(r2.transactions)).toEqual([toNano('10')]);
        });

        it('a grant after forced close still charges tokens consumed before closing', async () => {
            await setup(0n);
            await closeAndForce();
            const used = 2000n;
            const r = await grant(used);
            expect(payoutsToOwner(r.transactions)).toEqual([MIN_STAKE - used * PRICE_PER_TOKEN]);
        });

        it('a fully staked proxy sends no shortfall notice', async () => {
            await setup(toNano('20'));
            const r = await closeAndForce();
            expect(payoutsToOwner(r.transactions)).toEqual([MIN_STAKE]);
            expect(r.transactions).not.toHaveTransaction({ from: proxy.address, to: client.address });
            expect((await client.getData()).balance).toBe(0n);
        });

        it('the shortfall notice is accepted only from the client own proxy', async () => {
            await setup(0n);
            await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);
            blockchain.now! += CLIENT_DELAY + 1;
            await client.sendOwnerRequestRefund(clientOwner.getSender(), toNano('1'), clientOwner.address);
            const before = (await client.getData()).balance;

            const fake = beginCell()
                .storeUint(OP_PROXY_CLIENT_REFUND_SHORTFALL, 32)
                .storeUint(1, 64)
                .storeCoins(toNano('1000'))
                .endCell();
            const r = await operator.send({ to: client.address, value: toNano('1'), body: fake });
            expect(r.transactions).toHaveTransaction({
                to: client.address,
                success: false,
                exitCode: TestConstants.ERROR_CONTRACT_ADDRESS_MISMATCH,
            });
            expect((await client.getData()).balance).toBe(before);
        });

        it('the shortfall notice is rejected unless the client is closed', async () => {
            await setup(0n);
            const body = beginCell()
                .storeUint(OP_PROXY_CLIENT_REFUND_SHORTFALL, 32)
                .storeUint(1, 64)
                .storeCoins(toNano('1000'))
                .endCell();
            const r = await blockchain.sendMessage(
                internal({ from: proxy.address, to: client.address, value: toNano('0.1'), body }),
            );
            expect(r.transactions).toHaveTransaction({
                to: client.address,
                success: false,
                exitCode: TestConstants.ERROR_NOT_UNLOCKED_YET,
            });
            const c = await client.getData();
            expect(c.state).toBe(TestConstants.STATE_NORMAL);
            expect(c.balance).toBe(MIN_STAKE);
        });
    });
});
