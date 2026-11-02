import { toNano, Dictionary } from '@ton/core';
import { CocoonRoot, CocoonParams, CocoonRootConfig } from '../wrappers/CocoonRoot';
import { CocoonWorker } from '../wrappers/CocoonWorker';
import { CocoonClient } from '../wrappers/CocoonClient';
import { CocoonProxy } from '../wrappers/CocoonProxy';
import { compile, NetworkProvider } from '@ton/blueprint';
import {promptUrl, promptUserFriendlyAddress} from "../wrappers/ui-utils";

export async function run(provider: NetworkProvider) {
    const isTestnet = provider.network() !== 'mainnet';
    const ui = provider.ui();

    const workerCode = await compile('CocoonWorker');
    const clientCode = await compile('CocoonClient');
    const proxyCode = await compile('CocoonProxy');

    const adminAddress = await promptUserFriendlyAddress("Enter the address of the owner (admin):", ui, isTestnet);
    const ownerAddress = adminAddress.address;
    const uniqueId : number = 17;
    const isTest : boolean = true;
    const pricePerToken : bigint = BigInt(2);
    const workerFeePerToken : bigint = BigInt(1);
    const proxyDelayBeforeClose : number = 86400;
    const clientDelayBeforeClose : number = 86400;
    const minProxyStake : bigint = toNano(1.0);
    const minClientStake : bigint = toNano(1.0);

    const params : CocoonParams = {
      struct_version: 4,
      params_version: 0,
      unique_id: uniqueId,
      is_test: isTest,
      price_per_token: pricePerToken,
      worker_fee_per_token: workerFeePerToken,
      prompt_tokens_price_multiplier: 10000,
      cached_tokens_price_multiplier: 10000,
      completion_tokens_price_multiplier: 10000,
      reasoning_tokens_price_multiplier: 10000,
      proxy_delay_before_close : proxyDelayBeforeClose,
      client_delay_before_close: clientDelayBeforeClose,
      min_proxy_stake: minProxyStake,
      min_client_stake: minClientStake,
      proxy_sc_code: proxyCode,
      worker_sc_code: workerCode,
      client_sc_code: clientCode
    };

    const conf : CocoonRootConfig = {
      owner_address: ownerAddress,
      proxy_hashes: Dictionary.empty(null, null),
      registered_proxies: Dictionary.empty(null, null),
      last_proxy_seqno: 0,
      worker_hashes: Dictionary.empty(null, null),
      model_hashes: Dictionary.empty(null, null),
      version: 0,
      params: params,
      // cocoon_root.fc reads struct version 4 only and expects the key manager cell
      // (unpack_cocoon_root_data loads a third ref); without it every owner message fails with exit code 9.
      public_keys: Dictionary.empty(),
      key_manager_public_key: BigInt(0),
      key_manager_image_hash: BigInt(0),
      key_manager_net_addr: { addr: '' },
    };

    const cocoonRoot = provider.open(CocoonRoot.createFromConfig(conf, await compile('CocoonRoot')));

    await cocoonRoot.sendDeploy(provider.sender(), toNano('0.05'));

    await provider.waitForDeploy(cocoonRoot.address);

    // run methods on `cocoonRoot`
}
