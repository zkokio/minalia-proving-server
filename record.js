/**
 * recordVerificationOnChain
 * Sends a Mina transaction recording the proof hash in the memo field.
 * The fee is paid by the Minalia server wallet — players pay nothing.
 * Transaction is visible on Minascan as a self-transfer with memo.
 */

const NETWORKS = {
  devnet: {
    mina:     'https://api.minascan.io/node/devnet/v1/graphql',
    archive:  'https://api.minascan.io/archive/devnet/v1/graphql',
    explorer: 'https://minascan.io/devnet/tx/',
  },
  mainnet: {
    mina:     'https://api.minascan.io/node/mainnet/v1/graphql',
    archive:  'https://api.minascan.io/archive/mainnet/v1/graphql',
    explorer: 'https://minascan.io/mainnet/tx/',
  },
};

export async function recordVerificationOnChain({ walletAddress, proofHash, dayTimestamp, serverPrivateKey, zkAppAddress, network = 'devnet' }) {
  const { Mina, PrivateKey, PublicKey, AccountUpdate, fetchAccount, Memo } = await import('o1js');

  const net = NETWORKS[network];
  Mina.setActiveInstance(Mina.Network({ mina: net.mina, archive: net.archive }));

  const serverKey = PrivateKey.fromBase58(serverPrivateKey);
  const serverPub = serverKey.toPublicKey();
  const walletPub = PublicKey.fromBase58(walletAddress);

  await fetchAccount({ publicKey: serverPub });

  // Memo: first 32 chars of proof hash (Mina memo max is 32 bytes)
  const memo = proofHash.slice(0, 32);

  // Send a 0-MINA self-payment with proof hash as memo
  // This creates a permanent on-chain record of the verification
  const tx = await Mina.transaction(
    { sender: serverPub, fee: 10_000_000, memo }, // 0.01 MINA fee paid by server
    async () => {
      const update = AccountUpdate.create(serverPub);
      update.requireSignature();
    }
  );

  await tx.prove();
  tx.sign([serverKey]);
  const sent = await tx.send();

  return {
    txHash:      sent.hash,
    explorerUrl: net.explorer + sent.hash,
    network,
    memo,
  };
}
