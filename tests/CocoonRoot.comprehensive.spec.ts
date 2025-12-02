import { Blockchain, SandboxContract, TreasuryContract } from '@ton/sandbox';
import { Cell, toNano, Dictionary } from '@ton/core';
import { CocoonRoot, CocoonRootConfig } from '../wrappers/CocoonRoot';
import '@ton/test-utils';
import { compile } from '@ton/blueprint';
import { createDefaultParams, createTestHash, TestConstants, createProxyInfo } from './helpers/fixtures';
import { assertExcessesSent } from './helpers/fixtures';

describe('CocoonRoot - Comprehensive', () => {
    let code: Cell;
    let proxyCode: Cell;
    let workerCode: Cell;
    let clientCode: Cell;

    beforeAll(async () => {
        code = await compile('CocoonRoot');
        proxyCode = await compile('CocoonProxy');
        workerCode = await compile('CocoonWorker');
        clientCode = await compile('CocoonClient');
    });

    let blockchain: Blockchain;
    let deployer: SandboxContract<TreasuryContract>;
    let attacker: SandboxContract<TreasuryContract>;
    let cocoonRoot: SandboxContract<CocoonRoot>;

    beforeEach(async () => {
        blockchain = await Blockchain.create();
        deployer = await blockchain.treasury('deployer');
        attacker = await blockchain.treasury('attacker');

        const config: CocoonRootConfig = {
            owner_address: deployer.address,
            proxy_hashes: Dictionary.empty(),
            registered_proxies: Dictionary.empty(),
            last_proxy_seqno: 0,
            worker_hashes: Dictionary.empty(),
            model_hashes: Dictionary.empty(),
            version: 1,
            params: {
                ...createDefaultParams(),
                proxy_sc_code: proxyCode,
                worker_sc_code: workerCode,
                client_sc_code: clientCode,
            },
        };

        cocoonRoot = blockchain.openContract(CocoonRoot.createFromConfig(config, code));

        const deployResult = await cocoonRoot.sendDeploy(deployer.getSender(), toNano('0.05'));

        expect(deployResult.transactions).toHaveTransaction({
            from: deployer.address,
            to: cocoonRoot.address,
            deploy: true,
            success: true,
        });
    });

    describe('Hash Management - Parameterized Tests', () => {
        describe('Worker Hash Management', () => {
            it('should add worker hash and return excesses', async () => {
                const hash = createTestHash(1);
                const dataBefore = await cocoonRoot.getData();

                const result = await cocoonRoot.sendAddWorkerType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: deployer.address,
                    to: cocoonRoot.address,
                    success: true,
                });
                assertExcessesSent(result, deployer.address);

                const dataAfter = await cocoonRoot.getData();
                expect(dataAfter.version).toBe(dataBefore.version + 1);

                const isValid = await cocoonRoot.getWorkerHashIsValid(hash);
                expect(isValid).toBe(true);
            });

            it('should reject add worker hash from non-owner', async () => {
                const hash = createTestHash(2);

                const result = await cocoonRoot.sendAddWorkerType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });

            it('should delete worker hash', async () => {
                const hash = createTestHash(3);

                // Add first
                await cocoonRoot.sendAddWorkerType(deployer.getSender(), hash);
                expect(await cocoonRoot.getWorkerHashIsValid(hash)).toBe(true);

                // Then delete
                const result = await cocoonRoot.sendDelWorkerType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    to: cocoonRoot.address,
                    success: true,
                });
                assertExcessesSent(result, deployer.address);

                expect(await cocoonRoot.getWorkerHashIsValid(hash)).toBe(false);
            });

            it('should reject delete worker hash from non-owner', async () => {
                const hash = createTestHash(4);

                const result = await cocoonRoot.sendDelWorkerType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });
        });

        describe('Model Hash Management', () => {
            it('should add model hash and return excesses', async () => {
                const hash = createTestHash(10);

                const result = await cocoonRoot.sendAddModelType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    to: cocoonRoot.address,
                    success: true,
                });
                assertExcessesSent(result, deployer.address);

                const isValid = await cocoonRoot.getModelHashIsValid(hash);
                expect(isValid).toBe(true);
            });

            it('should reject add model hash from non-owner', async () => {
                const hash = createTestHash(11);

                const result = await cocoonRoot.sendAddModelType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });

            it('should delete model hash', async () => {
                const hash = createTestHash(12);

                await cocoonRoot.sendAddModelType(deployer.getSender(), hash);
                const result = await cocoonRoot.sendDelModelType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    to: cocoonRoot.address,
                    success: true,
                });
                expect(await cocoonRoot.getModelHashIsValid(hash)).toBe(false);
            });

            it('should reject delete model hash from non-owner', async () => {
                const hash = createTestHash(13);

                const result = await cocoonRoot.sendDelModelType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });
        });

        describe('Proxy Hash Management', () => {
            it('should add proxy hash and return excesses', async () => {
                const hash = createTestHash(20);

                const result = await cocoonRoot.sendAddProxyType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    to: cocoonRoot.address,
                    success: true,
                });
                assertExcessesSent(result, deployer.address);

                const isValid = await cocoonRoot.getProxyHashIsValid(hash);
                expect(isValid).toBe(true);
            });

            it('should reject add proxy hash from non-owner', async () => {
                const hash = createTestHash(21);

                const result = await cocoonRoot.sendAddProxyType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });

            it('should delete proxy hash', async () => {
                const hash = createTestHash(22);

                await cocoonRoot.sendAddProxyType(deployer.getSender(), hash);
                const result = await cocoonRoot.sendDelProxyType(deployer.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    to: cocoonRoot.address,
                    success: true,
                });
                expect(await cocoonRoot.getProxyHashIsValid(hash)).toBe(false);
            });

            it('should reject delete proxy hash from non-owner', async () => {
                const hash = createTestHash(23);

                const result = await cocoonRoot.sendDelProxyType(attacker.getSender(), hash);

                expect(result.transactions).toHaveTransaction({
                    from: attacker.address,
                    to: cocoonRoot.address,
                    success: false,
                    exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
                });
            });
        });
    });

    describe('Proxy Registration', () => {
        it('should register proxy and increment seqno', async () => {
            const proxyInfo = createProxyInfo('test-proxy.com');
            const seqnoBefore = await cocoonRoot.getLastProxySeqno();

            const result = await cocoonRoot.sendAddProxyInfo(deployer.getSender(), proxyInfo);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);

            const seqnoAfter = await cocoonRoot.getLastProxySeqno();
            expect(seqnoAfter).toBe(seqnoBefore + 1);
        });

        it('should reject proxy registration from non-owner', async () => {
            const proxyInfo = createProxyInfo();

            const result = await cocoonRoot.sendAddProxyInfo(attacker.getSender(), proxyInfo);

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });

        it('should update existing proxy info', async () => {
            const proxyInfo1 = createProxyInfo('proxy1.com');
            const proxyInfo2 = createProxyInfo('proxy2.com');

            // Register
            await cocoonRoot.sendAddProxyInfo(deployer.getSender(), proxyInfo1);
            const seqno = await cocoonRoot.getLastProxySeqno();

            // Update
            const result = await cocoonRoot.sendUpdateProxyInfo(deployer.getSender(), seqno, proxyInfo2);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);
        });

        it('should fail to update non-existent proxy', async () => {
            const proxyInfo = createProxyInfo();
            const nonExistentSeqno = 999;

            const result = await cocoonRoot.sendUpdateProxyInfo(deployer.getSender(), nonExistentSeqno, proxyInfo);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_UNKNOWN_PROXY_TYPE,
            });
        });

        it('should unregister proxy', async () => {
            const proxyInfo = createProxyInfo();

            await cocoonRoot.sendAddProxyInfo(deployer.getSender(), proxyInfo);
            const seqno = await cocoonRoot.getLastProxySeqno();

            const result = await cocoonRoot.sendDelProxyInfo(deployer.getSender(), seqno);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);
        });

        it('should reject unregister from non-owner', async () => {
            const result = await cocoonRoot.sendDelProxyInfo(attacker.getSender(), 1);

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });
    });

    describe('Parameter Changes', () => {
        it('should change fees and increment params version', async () => {
            const paramsBefore = await cocoonRoot.getAllParams();
            const newPricePerToken = toNano('0.002');
            const newWorkerFee = toNano('0.0002');

            const result = await cocoonRoot.sendChangeFees(deployer.getSender(), newPricePerToken, newWorkerFee);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);

            const paramsAfter = await cocoonRoot.getAllParams();
            expect(paramsAfter?.params.params_version).toBe(paramsBefore!.params.params_version + 1);
        });

        it('should reject change fees from non-owner', async () => {
            const result = await cocoonRoot.sendChangeFees(attacker.getSender(), toNano('0.002'), toNano('0.001'));

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });

        it('should change all params', async () => {
            const newPricePerToken = toNano('0.003');
            const newWorkerFee = toNano('0.0003');
            const newProxyDelay = 7200;
            const newClientDelay = 7200;
            const newMinProxyStake = toNano('2');
            const newMinClientStake = toNano('2');

            const result = await cocoonRoot.sendChangeParams(
                deployer.getSender(),
                newPricePerToken,
                newWorkerFee,
                newProxyDelay,
                newClientDelay,
                newMinProxyStake,
                newMinClientStake,
            );

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);
        });

        it('should upgrade contracts codes', async () => {
            const result = await cocoonRoot.sendUpdateContracts(
                deployer.getSender(),
                proxyCode,
                workerCode,
                clientCode,
            );

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);
        });

        it('should reject upgrade contracts from non-owner', async () => {
            const result = await cocoonRoot.sendUpdateContracts(
                attacker.getSender(),
                proxyCode,
                workerCode,
                clientCode,
            );

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });
    });

    describe('Admin Operations', () => {
        it('should upgrade own code', async () => {
            const newCode = await compile('CocoonRoot');

            const result = await cocoonRoot.sendUpdateCode(deployer.getSender(), newCode);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
        });

        it('should reject upgrade code from non-owner', async () => {
            const newCode = await compile('CocoonRoot');

            const result = await cocoonRoot.sendUpdateCode(attacker.getSender(), newCode);

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });

        it('should perform full upgrade (data + code)', async () => {
            const newCode = await compile('CocoonRoot');
            const newConfig: CocoonRootConfig = {
                owner_address: deployer.address,
                proxy_hashes: Dictionary.empty(),
                registered_proxies: Dictionary.empty(),
                last_proxy_seqno: 999,
                worker_hashes: Dictionary.empty(),
                model_hashes: Dictionary.empty(),
                version: 2,
                params: {
                    ...createDefaultParams(),
                    unique_id: 54321,
                    proxy_sc_code: proxyCode,
                    worker_sc_code: workerCode,
                    client_sc_code: clientCode,
                },
            };

            const result = await cocoonRoot.sendUpgradeFull(deployer.getSender(), newConfig, newCode);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);

            // Verify data was replaced
            const seqno = await cocoonRoot.getLastProxySeqno();
            expect(seqno).toBe(999);
        });

        it('should reset all dictionaries', async () => {
            // Add some data first
            const hash1 = createTestHash(100);
            const hash2 = createTestHash(101);
            const hash3 = createTestHash(102);

            await cocoonRoot.sendAddProxyType(deployer.getSender(), hash1);
            await cocoonRoot.sendAddWorkerType(deployer.getSender(), hash2);
            await cocoonRoot.sendAddModelType(deployer.getSender(), hash3);

            // Verify they exist
            expect(await cocoonRoot.getProxyHashIsValid(hash1)).toBe(true);
            expect(await cocoonRoot.getWorkerHashIsValid(hash2)).toBe(true);
            expect(await cocoonRoot.getModelHashIsValid(hash3)).toBe(true);

            // Reset
            const result = await cocoonRoot.sendReset(deployer.getSender());

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);

            // Verify they're gone
            expect(await cocoonRoot.getProxyHashIsValid(hash1)).toBe(false);
            expect(await cocoonRoot.getWorkerHashIsValid(hash2)).toBe(false);
            expect(await cocoonRoot.getModelHashIsValid(hash3)).toBe(false);
        });

        it('should change owner', async () => {
            const newOwner = await blockchain.treasury('newOwner');
            const dataBefore = await cocoonRoot.getData();

            const result = await cocoonRoot.sendChangeOwner(deployer.getSender(), newOwner.address);

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
            assertExcessesSent(result, deployer.address);

            const dataAfter = await cocoonRoot.getData();
            expect(dataAfter.version).toBe(dataBefore.version + 1);
            expect(dataAfter.ownerAddress.toString()).toBe(newOwner.address.toString());
        });

        it('should reject change owner from non-owner', async () => {
            const newOwner = await blockchain.treasury('newOwner');

            const result = await cocoonRoot.sendChangeOwner(attacker.getSender(), newOwner.address);

            expect(result.transactions).toHaveTransaction({
                from: attacker.address,
                to: cocoonRoot.address,
                success: false,
                exitCode: TestConstants.ERROR_EXPECTED_MESSAGE_FROM_OWNER,
            });
        });
    });

    describe('Getters', () => {
        it('should return correct last_proxy_seqno', async () => {
            const seqno1 = await cocoonRoot.getLastProxySeqno();
            expect(seqno1).toBe(0);

            await cocoonRoot.sendAddProxyInfo(deployer.getSender(), createProxyInfo());
            const seqno2 = await cocoonRoot.getLastProxySeqno();
            expect(seqno2).toBe(1);

            await cocoonRoot.sendAddProxyInfo(deployer.getSender(), createProxyInfo('proxy2.com'));
            const seqno3 = await cocoonRoot.getLastProxySeqno();
            expect(seqno3).toBe(2);
        });

        it('should return complete get_cocoon_data', async () => {
            const data = await cocoonRoot.getData();

            // get_cocoon_data returns: (version, last_proxy_seqno, params_version, unique_id, is_test,
            //   price_per_token, worker_fee_per_token, min_proxy_stake, min_client_stake, owner_address)
            expect(data.version).toBe(1);
            expect(data.lastProxySeqno).toBe(0);
            expect(data.paramsVersion).toBe(1);
            expect(data.uniqueId).toBe(12345);
            expect(data.isTest).toBe(1);
            expect(data.pricePerToken).toBe(Number(toNano('0.001')));
            expect(data.workerFeePerToken).toBe(toNano('0.0001'));
            expect(data.minProxyStake).toBe(toNano('1.0'));
            expect(data.minClientStake).toBe(toNano('1.0'));
            expect(data.ownerAddress.toString()).toBe(deployer.address.toString());
        });

        it('should return complete get_cur_params', async () => {
            const params = await cocoonRoot.getCurParams();

            // get_cur_params returns 14 fields in this order:
            // (params_version, unique_id, is_test, price_per_token, worker_fee_per_token,
            //  cached_tokens_price_multiplier, reasoning_tokens_price_multiplier,
            //  proxy_delay_before_close, client_delay_before_close,
            //  min_proxy_stake, min_client_stake,
            //  proxy_sc_hash, worker_sc_hash, client_sc_hash)

            expect(params.paramsVersion).toBe(1);
            expect(params.uniqueId).toBe(12345);
            expect(params.isTest).toBe(1);
            expect(params.pricePerToken).toBe(toNano('0.001'));
            expect(params.workerFeePerToken).toBe(toNano('0.0001'));
            expect(params.cachedTokensPriceMultiplier).toBe(12000);
            expect(params.reasoningTokensPriceMultiplier).toBe(14000);
            expect(params.proxyDelayBeforeClose).toBe(3600);
            expect(params.clientDelayBeforeClose).toBe(3600);
            expect(params.minProxyStake).toBe(toNano('1.0'));
            expect(params.minClientStake).toBe(toNano('1.0'));
            expect(params.proxyScHash).toBeGreaterThan(0n);
            expect(params.workerScHash).toBeGreaterThan(0n);
            expect(params.clientScHash).toBeGreaterThan(0n);
        });

        it('should validate hashes correctly', async () => {
            const proxyHash = createTestHash(200);
            const workerHash = createTestHash(201);
            const modelHash = createTestHash(202);

            // Initially invalid
            expect(await cocoonRoot.getProxyHashIsValid(proxyHash)).toBe(false);
            expect(await cocoonRoot.getWorkerHashIsValid(workerHash)).toBe(false);
            expect(await cocoonRoot.getModelHashIsValid(modelHash)).toBe(false);

            // Add them
            await cocoonRoot.sendAddProxyType(deployer.getSender(), proxyHash);
            await cocoonRoot.sendAddWorkerType(deployer.getSender(), workerHash);
            await cocoonRoot.sendAddModelType(deployer.getSender(), modelHash);

            // Now valid
            expect(await cocoonRoot.getProxyHashIsValid(proxyHash)).toBe(true);
            expect(await cocoonRoot.getWorkerHashIsValid(workerHash)).toBe(true);
            expect(await cocoonRoot.getModelHashIsValid(modelHash)).toBe(true);
        });
    });

    describe('Edge Cases', () => {
        it('should ignore empty messages', async () => {
            const result = await deployer.send({
                to: cocoonRoot.address,
                value: toNano('0.05'),
            });

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
        });

        it('should ignore OP_DO_NOT_PROCESS', async () => {
            const result = await blockchain.sendMessage({
                info: {
                    type: 'internal',
                    src: deployer.address,
                    dest: cocoonRoot.address,
                    value: { coins: toNano('0.05') },
                    bounce: true,
                    bounced: false,
                    ihrDisabled: true,
                    createdAt: 0,
                    createdLt: 0n,
                    ihrFee: 0n,
                    forwardFee: 0n,
                },
                body: (await import('@ton/core')).beginCell().storeUint(TestConstants.OP_DO_NOT_PROCESS, 32).endCell(),
            });

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: true,
            });
        });

        it('should reject unknown opcode', async () => {
            const result = await blockchain.sendMessage({
                info: {
                    type: 'internal',
                    src: deployer.address,
                    dest: cocoonRoot.address,
                    value: { coins: toNano('0.05') },
                    bounce: true,
                    bounced: false,
                    ihrDisabled: true,
                    createdAt: 0,
                    createdLt: 0n,
                    ihrFee: 0n,
                    forwardFee: 0n,
                },
                body: (await import('@ton/core'))
                    .beginCell()
                    .storeUint(0x99999999, 32) // Unknown opcode
                    .storeUint(0, 64)
                    .endCell(),
            });

            expect(result.transactions).toHaveTransaction({
                to: cocoonRoot.address,
                success: false,
            });
        });
    });
});
