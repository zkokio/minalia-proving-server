// Standalone deploy script — runs in child process with its own o1js instance
const { MinaliaVerifier } = require('./MinaliaVerifier.cjs');
const { Mina, PrivateKey, AccountUpdate, fetchAccount } = require('o1js');

const ZKAPP_PRIVATE_KEY  = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
const SERVER_PRIVATE_KEY = 'EKDxrPaymujx8HjZJ5iWLLQ4nCyyGa5HieoTEwdcX6T1GvPJgvv4';

async function deploy(network = 'mainnet') {
  const NETS = {
    mainnet: {
      mina:    'https://api.minascan.io/node/mainnet/v1/graphql',
      archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
    }
  };
  const net = NETS[network];
  Mina.setActiveInstance(Mina.Network({ mina: net.mina, archive: net.archive }));

  const zkAppKey  = PrivateKey.fromBase58(ZKAPP_PRIVATE_KEY);
  const zkAppPub  = zkAppKey.toPublicKey();
  const serverKey = PrivateKey.fromBase58(SERVER_PRIVATE_KEY);
  const serverPub = serverKey.toPublicKey();

  console.log('zkApp address:', zkAppPub.toBase58());
  console.log('Fee payer:    ', serverPub.toBase58());

  // Check if already deployed
  const zkAcc = await fetchAccount({ publicKey: zkAppPub });
  if (zkAcc.account?.zkapp) {
    return { ok: true, message: 'Already deployed', address: zkAppPub.toBase58() };
  }

  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Deploying...');

  const tx = await Mina.transaction({ sender: serverPub, fee: 100_000_000 }, async () => {
    AccountUpdate.fundNewAccount(serverPub);
    const zkApp = new MinaliaVerifier(zkAppPub);
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([serverKey, zkAppKey]);
  const sent = await tx.send();

  return {
    ok: true,
    txHash: sent.hash,
    explorerUrl: 'https://minascan.io/mainnet/tx/' + sent.hash,
    address: zkAppPub.toBase58()
  };
}

deploy().then(r => {
  console.log('Result:', JSON.stringify(r));
  process.send ? process.send({ ok: true, result: r }) : null;
  process.exit(0);
}).catch(e => {
  console.error('Deploy error:', e.message);
  process.send ? process.send({ ok: false, error: e.message }) : null;
  process.exit(1);
});
