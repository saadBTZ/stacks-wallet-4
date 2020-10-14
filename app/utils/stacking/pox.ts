import axios from 'axios';
import {
  makeContractCall,
  bufferCV,
  uintCV,
  tupleCV,
  StacksTestnet,
  broadcastTransaction,
  standardPrincipalCV,
  serializeCV,
  deserializeCV,
  TupleCV,
  ContractCallOptions,
  UIntCV,
  BufferCV,
  StacksNetwork,
  ContractCallPayload,
  StacksTransaction,
} from '@blockstack/stacks-transactions';
import BN from 'bn.js';
import { address } from 'bitcoinjs-lib';
import { BigNumber } from 'bignumber.js';

interface POXInfo {
  contract_id: string;
  first_burnchain_block_height: number;
  min_amount_ustx: number;
  registration_window_length: 250;
  rejection_fraction: number;
  reward_cycle_id: number;
  reward_cycle_length: number;
}

export interface StackerInfo {
  amountMicroSTX: string;
  firstRewardCycle: number;
  lockPeriod: number;
  poxAddr: {
    version: Buffer;
    hashbytes: Buffer;
  };
  btcAddress: string;
}

interface StackerInfoCV {
  'amount-ustx': UIntCV;
  'first-reward-cycle': UIntCV;
  'pox-addr': {
    data: {
      version: BufferCV;
      hashbytes: BufferCV;
    };
  };
  'lock-period': UIntCV;
}

export class POX {
  nodeURL = 'http://localhost:3999';

  constructor(nodeURL?: string) {
    if (nodeURL) {
      this.nodeURL = nodeURL;
    }
  }

  async getPOXInfo(): Promise<POXInfo> {
    const url = `${this.nodeURL}/v2/pox`;
    const res = await axios.get<POXInfo>(url);
    return res.data;
  }

  async lockSTX({
    amountMicroSTX,
    poxAddress,
    cycles,
    key,
    contract,
  }: {
    key: string;
    cycles: number;
    poxAddress: string;
    amountMicroSTX: BigNumber;
    contract: string;
  }) {
    const txOptions = this.getLockTxOptions({
      amountMicroSTX,
      cycles,
      poxAddress,
      contract,
    });
    const tx = await makeContractCall({
      ...txOptions,
      senderKey: key,
    });
    const res = await broadcastTransaction(tx, txOptions.network as StacksNetwork);
    if (typeof res === 'string') {
      return res;
    }
    throw new Error(`${res.error} - ${res.reason}`);
  }

  getLockTxOptions({
    amountMicroSTX,
    poxAddress,
    cycles,
    contract,
  }: {
    cycles: number;
    poxAddress: string;
    amountMicroSTX: BigNumber;
    contract: string;
  }) {
    const { version, hash } = this.convertBTCAddress(poxAddress);
    const versionBuffer = bufferCV(new BN(version, 10).toBuffer());
    const hashbytes = bufferCV(hash);
    const address = tupleCV({
      hashbytes,
      version: versionBuffer,
    });
    const [contractAddress, contractName]: string[] = contract.split('.');
    const network = new StacksTestnet();
    network.coreApiUrl = this.nodeURL;
    const txOptions: ContractCallOptions = {
      contractAddress,
      contractName,
      functionName: 'stack-stx',
      functionArgs: [uintCV(amountMicroSTX.toString(10)), address, uintCV(cycles)],
      validateWithAbi: true,
      network,
    };
    return txOptions;
  }

  modifyLockTxFee({ tx, amountMicroSTX }: { tx: StacksTransaction; amountMicroSTX: BigNumber }) {
    const fee = tx.auth.getFee() as BN;
    (tx.payload as ContractCallPayload).functionArgs[0] = uintCV(
      new BN(amountMicroSTX.toString(10), 10).sub(fee).toBuffer()
    );
    return tx;
  }

  async getStackerInfo(address: string): Promise<StackerInfo> {
    const info = await this.getPOXInfo();
    console.log(address);
    const args = [`0x${serializeCV(standardPrincipalCV(address)).toString('hex')}`];
    const res = await this.callReadOnly({
      contract: info.contract_id,
      args,
      functionName: 'get-stacker-info',
    });
    const cv = deserializeCV(Buffer.from(res.slice(2), 'hex')) as TupleCV;
    // Not sure why these types are off
    // eslint-disable-next-line @typescript-eslint/ban-ts-comment
    // @ts-ignore
    const data: StackerInfoCV = cv.value.data;
    const version = data['pox-addr'].data.version.buffer;
    const hashbytes = data['pox-addr'].data.hashbytes.buffer;
    return {
      lockPeriod: data['lock-period'].value.toNumber(),
      amountMicroSTX: data['amount-ustx'].value.toString(10),
      firstRewardCycle: data['first-reward-cycle'].value.toNumber(),
      poxAddr: {
        version,
        hashbytes,
      },
      btcAddress: this.getBTCAddress(version, hashbytes),
    };
  }

  async callReadOnly({
    contract,
    functionName,
    args,
  }: {
    contract: string;
    functionName: string;
    args: string[];
  }) {
    const [contractAddress, contractName] = contract.split('.');
    const url = `${this.nodeURL}/v2/contracts/call-read/${contractAddress}/${contractName}/${functionName}`;
    const body = {
      sender: 'ST384HBMC97973427QMM58NY2R9TTTN4M599XM5TD',
      arguments: args,
    };
    // Note: must include this custom header - the default Axios one for JSON
    // is not accepted by the core node.
    const response = await axios.post(url, body, {
      headers: {
        'Content-Type': 'application/json',
      },
    });
    return response.data.result as string;
  }

  convertBTCAddress(btcAddress: string) {
    return address.fromBase58Check(btcAddress);
  }

  getBTCAddress(version: Buffer, checksum: Buffer) {
    const btcAddress = address.toBase58Check(checksum, new BN(version).toNumber());
    return btcAddress;
  }
}