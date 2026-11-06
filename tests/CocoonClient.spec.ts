import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Address, beginCell, Cell, toNano } from '@ton/core';
import { CocoonClient, CocoonClientConfig } from '../wrappers/CocoonClient';
import { CocoonParams, cocoonParamsToCell } from '../wrappers/CocoonRoot';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { KeyPair, getSecureRandomBytes, keyPairFromSeed, sign } from '@ton/crypto';
import { TestConstants, createParamsCell } from './helpers/fixtures';

describe('CocoonClient', () => {
    let code: Cell;
    let keyPair: KeyPair;

    beforeAll(async () => {
        code = await compile('CocoonClient');
        keyPair = keyPairFromSeed(await getSecureRandomBytes(32));
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let owner: SandboxContract<TreasuryContract>;
    let proxy: SandboxContract<TreasuryContract>;
    let cocoonClient: SandboxContract<CocoonClient>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        owner = await blockchain.treasury('owner');
        proxy = await blockchain.treasury('proxy');

        const config: CocoonClientConfig = {
            ownerAddress: owner.address,
            proxyAddress: proxy.address,
            proxyPublicKey: BigInt('0x' + keyPair.publicKey.toString('hex')),
            state: TestConstants.STATE_NORMAL,
            balance: toNano('10'),
            stake: toNano('1'),
            tokensUsed: 0n,
            unlockTs: 0,
            secretHash: 0n,
            params: createParamsCell({
                params_version: 2,
                unique_id: 54321,
                is_test: false,
                price_per_token: toNano('0.005'),
                worker_fee_per_token: toNano('0.0005'),
                prompt_tokens_price_multiplier: 21000,
                cached_tokens_price_multiplier: 22000,
                completion_tokens_price_multiplier: 23000,
                reasoning_tokens_price_multiplier: 24000,
                proxy_delay_before_close: 7200,
                client_delay_before_close: 3600,
            }),
        };

        cocoonClient = blockchain.openContract(CocoonClient.createFromConfig(config, code));

        const deployResult = await cocoonClient.sendDeploy(deployer.getSender(), toNano('15'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: cocoonClient.address,
            deploy: true,
            success: true,
        });
    });

    it('should deploy', async () => {
        // the check is done inside beforeEach
    });

    it('should have correct initial state', async () => {
        const data = await cocoonClient.getData();
        expect(data.ownerAddress.equals(owner.address)).toBe(true);
        expect(data.proxyAddress.equals(proxy.address)).toBe(true);
        expect(data.state).toBe(TestConstants.STATE_NORMAL);
        expect(data.balance).toBe(toNano('10'));
        expect(data.stake).toBe(toNano('1'));
        expect(data.tokensUsed).toBe(0n);
    });

    it('should ignore empty messages', async () => {
        const result = await deployer.send({
            to: cocoonClient.address,
            value: toNano('0.05'),
            body: beginCell().endCell(),
        });

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: cocoonClient.address,
            success: true,
        });
    });

    describe('ext_client_top_up', () => {
        it('should top up balance', async () => {
            const topUpAmount = toNano('5');
            const result = await cocoonClient.sendExtTopUp(
                deployer.getSender(),
                toNano('6'),
                topUpAmount,
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: true,
            });

            // Should forward message to proxy
            expect(result.transactions).toHaveTransaction({
                from: cocoonClient.address,
                to: proxy.address,
            });
        });

        it('should reject if closed', async () => {
            // Deploy with closed state
            const closedConfig: CocoonClientConfig = {
                ownerAddress: owner.address,
                proxyAddress: proxy.address,
                proxyPublicKey: BigInt('0x' + keyPair.publicKey.toString('hex')),
                state: TestConstants.STATE_CLOSED,
                balance: toNano('10'),
                stake: toNano('1'),
                tokensUsed: 0n,
                unlockTs: 0,
                secretHash: 0n,
                params: createParamsCell({
                params_version: 2,
                unique_id: 54321,
                is_test: false,
                price_per_token: toNano('0.005'),
                worker_fee_per_token: toNano('0.0005'),
                prompt_tokens_price_multiplier: 21000,
                cached_tokens_price_multiplier: 22000,
                completion_tokens_price_multiplier: 23000,
                reasoning_tokens_price_multiplier: 24000,
                proxy_delay_before_close: 7200,
                client_delay_before_close: 3600,
            }),
            };

            const closedClient = blockchain.openContract(CocoonClient.createFromConfig(closedConfig, code));
            await closedClient.sendDeploy(deployer.getSender(), toNano('15'));

            const result = await closedClient.sendExtTopUp(
                deployer.getSender(),
                toNano('6'),
                toNano('5'),
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: closedClient.address,
                success: false,
            });
        });

        it('should reject if value is too low', async () => {
            const result = await cocoonClient.sendExtTopUp(
                deployer.getSender(),
                toNano('0.01'), // Too low
                toNano('5'),
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_change_secret_hash_and_top_up', () => {
        it('should change secret hash and top up from owner', async () => {
            const newSecretHash = 12345n;
            const result = await cocoonClient.sendOwnerChangeSecretHashAndTopUp(
                owner.getSender(),
                toNano('6'),
                toNano('5'),
                newSecretHash,
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            const data = await cocoonClient.getData();
            expect(data.secretHash).toBe(newSecretHash);
        });

        it('should reject from non-owner', async () => {
            const result = await cocoonClient.sendOwnerChangeSecretHashAndTopUp(
                deployer.getSender(),
                toNano('6'),
                toNano('5'),
                12345n,
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: false,
            });
        });

        it('should reject if closed', async () => {
            const closedConfig: CocoonClientConfig = {
                ownerAddress: owner.address,
                proxyAddress: proxy.address,
                proxyPublicKey: BigInt('0x' + keyPair.publicKey.toString('hex')),
                state: TestConstants.STATE_CLOSED,
                balance: toNano('10'),
                stake: toNano('1'),
                tokensUsed: 0n,
                unlockTs: 0,
                secretHash: 0n,
                params: createParamsCell({
                params_version: 2,
                unique_id: 54321,
                is_test: false,
                price_per_token: toNano('0.005'),
                worker_fee_per_token: toNano('0.0005'),
                prompt_tokens_price_multiplier: 21000,
                cached_tokens_price_multiplier: 22000,
                completion_tokens_price_multiplier: 23000,
                reasoning_tokens_price_multiplier: 24000,
                proxy_delay_before_close: 7200,
                client_delay_before_close: 3600,
            }),
            };

            const closedClient = blockchain.openContract(CocoonClient.createFromConfig(closedConfig, code));
            await closedClient.sendDeploy(deployer.getSender(), toNano('15'));

            const result = await closedClient.sendOwnerChangeSecretHashAndTopUp(
                owner.getSender(),
                toNano('6'),
                toNano('5'),
                12345n,
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: closedClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_register', () => {
        it('should register from owner', async () => {
            const result = await cocoonClient.sendOwnerRegister(
                owner.getSender(),
                toNano('0.15'),
                123n,
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            // Should forward to proxy
            expect(result.transactions).toHaveTransaction({
                from: cocoonClient.address,
                to: proxy.address,
            });
        });

        it('should pass the nonce to the proxy (read by the proxy runner)', async () => {
            const result = await cocoonClient.sendOwnerRegister(
                owner.getSender(),
                toNano('0.15'),
                123n,
                owner.address
            );

            const tx = result.transactions.find(
                (t) => t.inMessage?.info.dest?.toString() === proxy.address.toString() &&
                       t.inMessage?.info.src?.toString() === cocoonClient.address.toString()
            );
            expect(tx).toBeDefined();
            const body = tx!.inMessage!.body.beginParse();
            expect(body.loadUint(32)).toBe(0x65448ff4); // client_proxy_request
            body.loadUint(64);                        // query_id
            body.loadAddress();                       // client owner
            body.loadRef();                           // client state
            expect(body.loadBit()).toBe(true);        // has payload
            const payload = body.loadRef().beginParse();
            expect(payload.loadUint(32)).toBe(0xa35cb580); // client_proxy_register
            expect(payload.loadUintBig(64)).toBe(123n);    // nonce
        });

        it('should reject from non-owner', async () => {
            const result = await cocoonClient.sendOwnerRegister(
                deployer.getSender(),
                toNano('0.15'),
                123n,
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_change_secret_hash', () => {
        it('should change secret hash from owner', async () => {
            const newSecretHash = 9999n;
            const result = await cocoonClient.sendOwnerChangeSecretHash(
                owner.getSender(),
                toNano('0.15'),
                newSecretHash,
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            const data = await cocoonClient.getData();
            expect(data.secretHash).toBe(newSecretHash);
        });

        it('should reject from non-owner', async () => {
            const result = await cocoonClient.sendOwnerChangeSecretHash(
                deployer.getSender(),
                toNano('0.15'),
                9999n,
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_increase_stake', () => {
        it('[BUG #4] should allow INCREASING stake (but currently fails due to inverted logic)', async () => {
            // BUG: The contract checks `new_stake <= stake` instead of `new_stake >= stake`
            // This means it REJECTS valid increases and ALLOWS invalid decreases

            // Get current stake (should be 1 TON from setup)
            const dataBefore = await cocoonClient.getData();
            const currentStake = dataBefore.stake;
            expect(currentStake).toBe(toNano('1')); // Verify initial stake

            // Try to INCREASE stake from 1 TON to 2 TON (should succeed)
            const newStake = toNano('2'); // HIGHER than current (valid increase)
            const result = await cocoonClient.sendOwnerIncreaseStake(
                owner.getSender(),
                toNano('4'),
                newStake,
                owner.address
            );

            // EXPECT: Should succeed because we're increasing stake
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            // Verify stake was updated
            const dataAfter = await cocoonClient.getData();
            expect(dataAfter.stake).toBe(newStake);
        });

        it('[BUG #4] should FORBID decreasing stake (but currently allows it due to inverted logic)', async () => {
            // BUG: The contract checks `new_stake <= stake` instead of `new_stake >= stake`
            // This means stake DECREASES are ALLOWED when they should be FORBIDDEN

            // Get current stake (should be 1 TON from setup)
            const dataBefore = await cocoonClient.getData();
            const currentStake = dataBefore.stake;
            expect(currentStake).toBe(toNano('1')); // Verify initial stake

            // Try to DECREASE stake from 1 TON to 0.5 TON (should fail)
            const newStake = toNano('0.5'); // LOWER than current (invalid decrease)
            const result = await cocoonClient.sendOwnerIncreaseStake(
                owner.getSender(),
                toNano('4'),
                newStake,
                owner.address
            );

            // EXPECT: Should FAIL because we're decreasing stake (not allowed)
            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: false,
                exitCode: 1003, // ERROR_LOW_MSG_VALUE
            });

            // Verify stake was NOT changed
            const dataAfter = await cocoonClient.getData();
            expect(dataAfter.stake).toBe(currentStake); // Should still be 1 TON
        });

        it('should increase stake from owner', async () => {
            const newStake = toNano('4');
            const result = await cocoonClient.sendOwnerIncreaseStake(
                owner.getSender(),
                toNano('1'),
                newStake,
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            const data = await cocoonClient.getData();
            expect(data.stake).toBe(newStake);
        });

        it('should reject if new stake is lower', async () => {
            const result = await cocoonClient.sendOwnerIncreaseStake(
                owner.getSender(),
                toNano('2'),
                toNano('0.5'), // Lower than current
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_withdraw', () => {
        it('should withdraw excess balance', async () => {
            // Client has balance = 10 TON, stake = 1 TON, so can withdraw 9 TON
            const result = await cocoonClient.sendOwnerWithdraw(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: true,
            });

            // Should forward refund to proxy
            expect(result.transactions).toHaveTransaction({
                from: cocoonClient.address,
                to: proxy.address,
            });

            const data = await cocoonClient.getData();
            expect(data.balance).toBe(toNano('1')); // Should equal stake now
        });

        it('should reject if balance <= stake', async () => {
            const lowBalanceConfig: CocoonClientConfig = {
                ownerAddress: owner.address,
                proxyAddress: proxy.address,
                proxyPublicKey: BigInt('0x' + keyPair.publicKey.toString('hex')),
                state: TestConstants.STATE_NORMAL,
                balance: toNano('0.5'), // Less than stake
                stake: toNano('1'),
                tokensUsed: 0n,
                unlockTs: 0,
                secretHash: 0n,
                params: createParamsCell({
                params_version: 2,
                unique_id: 54321,
                is_test: false,
                price_per_token: toNano('0.005'),
                worker_fee_per_token: toNano('0.0005'),
                prompt_tokens_price_multiplier: 21000,
                cached_tokens_price_multiplier: 22000,
                completion_tokens_price_multiplier: 23000,
                reasoning_tokens_price_multiplier: 24000,
                proxy_delay_before_close: 7200,
                client_delay_before_close: 3600,
            }),
            };

            const lowBalanceClient = blockchain.openContract(CocoonClient.createFromConfig(lowBalanceConfig, code));
            await lowBalanceClient.sendDeploy(deployer.getSender(), toNano('5'));

            const result = await lowBalanceClient.sendOwnerWithdraw(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: lowBalanceClient.address,
                success: false,
            });
        });

        it('should reject from non-owner', async () => {
            const result = await cocoonClient.sendOwnerWithdraw(
                deployer.getSender(),
                toNano('0.15'),
                deployer.address
            );

            expect(result.transactions).toHaveTransaction({
                from: deployer.address,
                to: cocoonClient.address,
                success: false,
            });
        });
    });

    describe('owner_client_request_refund', () => {
        it('should request refund from normal state (transition to closing)', async () => {
            await cocoonClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            const data = await cocoonClient.getData();
            expect(data.state).toBe(TestConstants.STATE_CLOSING);
            expect(data.unlockTs).toBeGreaterThan(0);
            expect(data.balance).toBe(toNano('1')); // Should be reduced to stake
        });

        it('should close from closing state when unlocked', async () => {
            // First request refund to go to closing state
            await cocoonClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            // Advance time past unlock
            blockchain.now = Math.floor(Date.now() / 1000) + 3700;

            // Request refund again to close
            await cocoonClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            const data = await cocoonClient.getData();
            expect(data.state).toBe(TestConstants.STATE_CLOSED);
            expect(data.balance).toBe(0n);
        });

        it('should reject from closing state before unlock', async () => {
            // First request refund to go to closing state
            await cocoonClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            // Try to close immediately without waiting
            const result = await cocoonClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: cocoonClient.address,
                success: false,
            });
        });

        it('should reject if already closed', async () => {
            const closedConfig: CocoonClientConfig = {
                ownerAddress: owner.address,
                proxyAddress: proxy.address,
                proxyPublicKey: BigInt('0x' + keyPair.publicKey.toString('hex')),
                state: TestConstants.STATE_CLOSED,
                balance: toNano('10'),
                stake: toNano('1'),
                tokensUsed: 0n,
                unlockTs: 0,
                secretHash: 0n,
                params: createParamsCell({
                params_version: 2,
                unique_id: 54321,
                is_test: false,
                price_per_token: toNano('0.005'),
                worker_fee_per_token: toNano('0.0005'),
                prompt_tokens_price_multiplier: 21000,
                cached_tokens_price_multiplier: 22000,
                completion_tokens_price_multiplier: 23000,
                reasoning_tokens_price_multiplier: 24000,
                proxy_delay_before_close: 7200,
                client_delay_before_close: 3600,
            }),
            };

            const closedClient = blockchain.openContract(CocoonClient.createFromConfig(closedConfig, code));
            await closedClient.sendDeploy(deployer.getSender(), toNano('15'));

            const result = await closedClient.sendOwnerRequestRefund(
                owner.getSender(),
                toNano('0.15'),
                owner.address
            );

            expect(result.transactions).toHaveTransaction({
                from: owner.address,
                to: closedClient.address,
                success: false,
            });
        });
    });

    it('should reject unknown opcodes', async () => {
        const result = await deployer.send({
            to: cocoonClient.address,
            value: toNano('0.05'),
            body: beginCell()
                .storeUint(0x12345678, 32) // Unknown opcode
                .storeUint(0, 64)
                .endCell(),
        });

        expect(result.transactions).toHaveTransaction({
            from: deployer.address,
            to: cocoonClient.address,
            success: false,
        });
    });
});
