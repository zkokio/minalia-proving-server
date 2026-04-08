/**
 * recordVerification.mjs
 * 
 * Called by the proving server after proof generation to record
 * the proof hash on-chain in the MinaliaVerifier zkApp.
 * 
 * Usage: node record.mjs <walletAddress> <proofHash> <dayTimestamp>
 */

import { MinaliaVerifier } from './MinaliaVerifier.mjs';
import {
  Mina, PrivateKey, PublicKey, Field, fetchAccount
} from 'o1js';

const NETWORKS = {
  devnet: {
    mina:    'https://api.minascan.io/node/devnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/devnet/v1/graphql',
    explorer: 'https://minascan.io/devnet/tx/',
  },
  mainnet: {
    mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
    archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    explorer: 'https://minascan.io/mainnet/tx/',
  },
};

export async function recordVerificationOnChain({
  walletAddress,
  proofHash,
  dayTimestamp,
  serverPrivateKey,
  zkAppAddress,
  network = 'devnet',
}) {
  const net = NETWORKS[network];
  Mina.setActiveInstance(Mina.Network({ mina: net.mina, archive: net.archive }));

  const deployerKey    = PrivateKey.fromBase58(serverPrivateKey);
  const deployerPubKey = deployerKey.toPublicKey();
  const zkAppPubKey    = PublicKey.fromBase58(zkAppAddress);
  const walletPubKey   = PublicKey.fromBase58(walletAddress);

  // Split proof hash (hex string) into two Field values
  const hashBigInt  = BigInt('0x' + proofHash.padStart(64, '0'));
  const LOW_MASK    = (1n << 128n) - 1n;
  const proofHashLow  = Field(hashBigInt & LOW_MASK);
  const proofHashHigh = Field(hashBigInt >> 128n);

  // Fetch accounts
  await fetchAccount({ publicKey: deployerPubKey });
  await fetchAccount({ publicKey: zkAppPubKey });

  // Compile & build transaction
  await MinaliaVerifier.compile();

  const zkApp = new MinaliaVerifier(zkAppPubKey);
  const tx = await Mina.transaction(
    { sender: deployerPubKey, fee: 10_000_000 }, // 0.01 MINA
    async () => {
      await zkApp.recordVerification(
        walletPubKey,
        proofHashLow,
        proofHashHigh,
        Field(dayTimestamp),
        deployerPubKey,
      );
    }
  );

  await tx.prove();
  tx.sign([deployerKey]);

  const result = await tx.send();
  const txHash = result.hash;

  return {
    txHash,
    explorerUrl: net.explorer + txHash,
    network,
  };
}
