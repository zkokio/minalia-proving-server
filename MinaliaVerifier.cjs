"use strict";
var __decorate = (this && this.__decorate) || function (decorators, target, key, desc) {
    var c = arguments.length, r = c < 3 ? target : desc === null ? desc = Object.getOwnPropertyDescriptor(target, key) : desc, d;
    if (typeof Reflect === "object" && typeof Reflect.decorate === "function") r = Reflect.decorate(decorators, target, key, desc);
    else for (var i = decorators.length - 1; i >= 0; i--) if (d = decorators[i]) r = (c < 3 ? d(r) : c > 3 ? d(target, key, r) : d(target, key)) || r;
    return c > 3 && r && Object.defineProperty(target, key, r), r;
};
var __metadata = (this && this.__metadata) || function (k, v) {
    if (typeof Reflect === "object" && typeof Reflect.metadata === "function") return Reflect.metadata(k, v);
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.MinaliaVerifier = exports.VerificationEvent = void 0;
exports.recordVerificationOnChain = recordVerificationOnChain;
const o1js_1 = require("o1js");
class VerificationEvent extends (0, o1js_1.Struct)({
    walletX: o1js_1.Field,
    walletY: o1js_1.Field,
    proofHashLow: o1js_1.Field,
    proofHashHigh: o1js_1.Field,
    dayTimestamp: o1js_1.Field,
}) {
}
exports.VerificationEvent = VerificationEvent;
class MinaliaVerifier extends o1js_1.SmartContract {
    constructor() {
        super(...arguments);
        this.totalVerifications = (0, o1js_1.State)();
        this.lastWalletX = (0, o1js_1.State)();
        this.lastProofHashLow = (0, o1js_1.State)();
        this.lastProofHashHigh = (0, o1js_1.State)();
        this.lastDayTimestamp = (0, o1js_1.State)();
        this.events = { verification: VerificationEvent };
    }
    init() {
        super.init();
        this.totalVerifications.set((0, o1js_1.Field)(0));
        this.lastWalletX.set((0, o1js_1.Field)(0));
        this.lastProofHashLow.set((0, o1js_1.Field)(0));
        this.lastProofHashHigh.set((0, o1js_1.Field)(0));
        this.lastDayTimestamp.set((0, o1js_1.Field)(0));
    }
    async recordVerification(walletPublicKey, proofHashLow, proofHashHigh, dayTimestamp) {
        const total = this.totalVerifications.getAndRequireEquals();
        this.totalVerifications.set(total.add((0, o1js_1.Field)(1)));
        this.lastWalletX.set(walletPublicKey.x);
        this.lastProofHashLow.set(proofHashLow);
        this.lastProofHashHigh.set(proofHashHigh);
        this.lastDayTimestamp.set(dayTimestamp);
        this.emitEvent('verification', new VerificationEvent({
            walletX: walletPublicKey.x,
            walletY: walletPublicKey.toGroup().y,
            proofHashLow,
            proofHashHigh,
            dayTimestamp,
        }));
    }
}
exports.MinaliaVerifier = MinaliaVerifier;
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "totalVerifications", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastWalletX", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastProofHashLow", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastProofHashHigh", void 0);
__decorate([
    (0, o1js_1.state)(o1js_1.Field),
    __metadata("design:type", Object)
], MinaliaVerifier.prototype, "lastDayTimestamp", void 0);
__decorate([
    o1js_1.method,
    __metadata("design:type", Function),
    __metadata("design:paramtypes", [o1js_1.PublicKey,
        o1js_1.Field,
        o1js_1.Field,
        o1js_1.Field]),
    __metadata("design:returntype", Promise)
], MinaliaVerifier.prototype, "recordVerification", null);
// ── Record a verification on-chain ──
async function recordVerificationOnChain({ walletAddress, proofHash, dayTimestamp, serverPrivateKey, zkAppAddress, network = 'devnet', }) {
    const NETS = {
        devnet: {
            mina: 'https://api.minascan.io/node/devnet/v1/graphql',
            archive: 'https://api.minascan.io/archive/devnet/v1/graphql',
            explorer: 'https://minascan.io/devnet/tx/',
        },
        mainnet: {
            mina: 'https://api.minascan.io/node/mainnet/v1/graphql',
            archive: 'https://api.minascan.io/archive/mainnet/v1/graphql',
            explorer: 'https://minascan.io/mainnet/tx/',
        },
    };
    const net = NETS[network];
    o1js_1.Mina.setActiveInstance(o1js_1.Mina.Network({ mina: net.mina, archive: net.archive, networkId: network === 'mainnet' ? 'mainnet' : 'testnet' }));
    // Use zkApp key as fee payer — it holds the mainnet MINA (B62qoT7...)
    const ZKAPP_FEE_PAYER_KEY = 'EKEbTpyViqHqqhL5CBwEfbuk2xgtakja8vciLY33juYAvGEPjCUS';
    const feePayerKey = o1js_1.PrivateKey.fromBase58(ZKAPP_FEE_PAYER_KEY);
    const feePayerPub = feePayerKey.toPublicKey();
    const zkPub = o1js_1.PublicKey.fromBase58(zkAppAddress);
    const walletPub = o1js_1.PublicKey.fromBase58(walletAddress);
    await (0, o1js_1.fetchAccount)({ publicKey: feePayerPub });
    await (0, o1js_1.fetchAccount)({ publicKey: zkPub });
    // Split 64-char hex proof hash into two Field values (128 bits each)
    const hashBig = BigInt('0x' + proofHash.padStart(64, '0'));
    const LOW_MASK = (1n << 128n) - 1n;
    const proofHashLow = (0, o1js_1.Field)(hashBig & LOW_MASK);
    const proofHashHigh = (0, o1js_1.Field)(hashBig >> 128n);
    console.log('Compiling MinaliaVerifier for record...');
    await MinaliaVerifier.compile();
    console.log('Compiled.');
    const zkApp = new MinaliaVerifier(zkPub);
    const tx = await o1js_1.Mina.transaction({ sender: feePayerPub, fee: 10_000_000 }, async () => {
        await zkApp.recordVerification(walletPub, proofHashLow, proofHashHigh, (0, o1js_1.Field)(dayTimestamp));
    });
    await tx.prove();
    tx.sign([feePayerKey]);
    const sent = await tx.send();
    return {
        txHash: sent.hash,
        explorerUrl: net.explorer + sent.hash,
        network,
    };
}
