#!/usr/bin/env node
// Pure CJS mainnet deploy — writes TS inline, compiles and runs it
// No ESM/CJS o1js instance conflicts

const { execSync, execFileSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const ZKAPP_PRIVATE_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
const ZKAPP_ADDRESS     = 'B62qoT7pZo8Lhh42ZXuD88xUBGvkFKHdVBahjUXEHAZFWkFquJBMxRi';

const tmpDir = path.join(__dirname, 'tmp-mainnet-deploy');
if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir);

fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({
  name: 'tmp-mainnet-deploy', type: 'module',
  dependencies: { o1js: '^2.1.0' },
  devDependencies: { '@types/node': '^20.0.0', typescript: '^5.0.0' }
}));

fs.writeFileSync(path.join(tmpDir, 'tsconfig.json'), JSON.stringify({
  compilerOptions: {
    target: 'ES2021', module: 'NodeNext', moduleResolution: 'NodeNext',
    experimentalDecorators: true, emitDecoratorMetadata: true,
    strict: false, skipLibCheck: true, outDir: 'dist', types: ['node']
  },
  include: ['*.ts']
}));

fs.writeFileSync(path.join(tmpDir, 'deploy.ts'), `
import { SmartContract, state, State, method, Field, PublicKey, Struct, Mina, PrivateKey, fetchAccount, AccountUpdate } from 'o1js';

class VerificationEvent extends Struct({
  walletX: Field, walletY: Field,
  proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
}) {}

class MinaliaVerifier extends SmartContract {
  @state(Field) totalVerifications = State<Field>();
  @state(Field) lastWalletX        = State<Field>();
  @state(Field) lastProofHashLow   = State<Field>();
  @state(Field) lastProofHashHigh  = State<Field>();
  @state(Field) lastDayTimestamp   = State<Field>();
  events = { verification: VerificationEvent };

  init() {
    super.init();
    this.totalVerifications.set(Field(0));
    this.lastWalletX.set(Field(0));
    this.lastProofHashLow.set(Field(0));
    this.lastProofHashHigh.set(Field(0));
    this.lastDayTimestamp.set(Field(0));
  }

  @method async recordVerification(
    walletPublicKey: PublicKey, proofHashLow: Field, proofHashHigh: Field, dayTimestamp: Field,
  ) {
    const total = this.totalVerifications.getAndRequireEquals();
    this.totalVerifications.set(total.add(Field(1)));
    this.lastWalletX.set(walletPublicKey.x);
    this.lastProofHashLow.set(proofHashLow);
    this.lastProofHashHigh.set(proofHashHigh);
    this.lastDayTimestamp.set(dayTimestamp);
    this.emitEvent('verification', new VerificationEvent({
      walletX: walletPublicKey.x, walletY: walletPublicKey.toGroup().y,
      proofHashLow, proofHashHigh, dayTimestamp,
    }));
  }
}

async function main() {
  const MAINNET = 'https://api.minascan.io/node/mainnet/v1/graphql';
  const ARCHIVE = 'https://api.minascan.io/archive/mainnet/v1/graphql';
  // Fee payer = existing funded wallet (B62qoT7...)
  // zkApp = fresh unfunded address (B62qrmr7...)
  const FEE_PAYER_KEY   = '${ZKAPP_PRIVATE_KEY}';
  const FEE_PAYER_ADDR  = '${ZKAPP_ADDRESS}';
  const ZKAPP_PRIV      = 'EKEtrsnmpwaMKo8hBabBnoWersto29LpLXkxDE98jFGTeYfJvQwg';
  const ZKAPP_ADDR      = 'B62qrmr7hZjMkAdfcSXr1A1bYTn1vQEvGFVYe5yKitPmtWE5RNjHEtf';

  Mina.setActiveInstance(Mina.Network({ mina: MAINNET, archive: ARCHIVE }));

  const feePayerKey = PrivateKey.fromBase58(FEE_PAYER_KEY);
  const feePayerPub = PublicKey.fromBase58(FEE_PAYER_ADDR);
  const zkKey = PrivateKey.fromBase58(ZKAPP_PRIV);
  const zkPub = PublicKey.fromBase58(ZKAPP_ADDR);

  console.log('Fee payer:', feePayerPub.toBase58());
  console.log('zkApp address:', zkPub.toBase58());

  const { account: fpAcc } = await fetchAccount({ publicKey: feePayerPub });
  console.log('Fee payer balance:', fpAcc ? Number(fpAcc.balance.toBigInt()) / 1e9 + ' MINA' : 'NOT FOUND');
  if (!fpAcc) { console.error('Fee payer not found on mainnet.'); process.exit(1); }

  const { account: zkAcc } = await fetchAccount({ publicKey: zkPub });
  if (zkAcc?.zkapp) { console.log('Already deployed!'); process.exit(0); }

  console.log('Compiling MinaliaVerifier...');
  await MinaliaVerifier.compile();
  console.log('Compiled. Deploying...');

  const zkApp = new MinaliaVerifier(zkPub);
  const tx = await Mina.transaction({ sender: feePayerPub, fee: 100_000_000, memo: 'Minalia zkApp deploy' }, async () => {
    AccountUpdate.fundNewAccount(feePayerPub);
    await zkApp.deploy();
  });
  await tx.prove();
  tx.sign([feePayerKey, zkKey]);

  console.log('Sending deploy transaction...');
  const sent = await tx.send();

  console.log('\\n✅ DEPLOYED SUCCESSFULLY!');
  console.log('Transaction hash:', sent.hash);
  console.log('Minascan: https://minascan.io/mainnet/tx/' + sent.hash);
}

main().catch(e => { console.error('Deploy failed:', e.message); process.exit(1); });
`);

console.log('Installing dependencies in tmp dir...');
execSync('npm install', { cwd: tmpDir, stdio: 'inherit' });
console.log('Compiling TypeScript...');
execSync('npx tsc', { cwd: tmpDir, stdio: 'inherit' });
console.log('Running deploy...\n');
execFileSync('node', ['dist/deploy.js'], {
  cwd: tmpDir, stdio: 'inherit', env: { ...process.env }
});
