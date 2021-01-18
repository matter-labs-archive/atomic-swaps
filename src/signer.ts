import { MusigBN256WasmSigner, MusigBN256WasmAggregatedPubkey } from 'musig-bindings';
import { utils, BytesLike } from 'ethers';
import { rescueHashTx } from 'zksync-crypto';
import * as crypto from 'crypto';

export class MusigSigner {
    private signers: MusigBN256WasmSigner[];

    constructor(private pubkeys: BytesLike[], position: number, private N: number = 1) {
        this.signers = [];
        for (let i = 0; i < this.N; i++) {
            this.signers[i] = MusigBN256WasmSigner.new(utils.concat(pubkeys), position);
        }
    }

    computePubkey(): Uint8Array {
        return MusigBN256WasmAggregatedPubkey.compute(utils.concat(this.pubkeys));
    }

    computePrecommitments(): Uint8Array[] {
        let precommitments = [];
        for (let i = 0; i < this.N; i++) {
            const seed = crypto.randomFillSync(new Uint32Array(4));
            precommitments[i] = this.signers[i].compute_precommitment(seed);
        }
        return precommitments;
    }

    receivePrecommitments(precommitments: BytesLike[][]): Uint8Array[] {
        let commitments = [];
        for (let i = 0; i < this.N; i++) {
            commitments[i] = this.signers[i].receive_precommitments(utils.concat(precommitments[i]));
        }
        return commitments;
    }

    receiveCommitments(commitments: BytesLike[][]) {
        for (let i = 0; i < this.N; i++) {
            this.signers[i].receive_commitments(utils.concat(commitments[i]));
        }
    }

    sign(privkey: BytesLike, message: BytesLike, index: number): Uint8Array {
        const hash = rescueHashTx(utils.arrayify(message));
        return this.signers[index].sign(utils.arrayify(privkey), hash);
    }

    receiveSignatureShares(signature_shares: BytesLike[], index: number): Uint8Array {
        return this.signers[index].receive_signature_shares(utils.concat(signature_shares));
    }
}
