import { ethers } from 'ethers';

let backendSigner: ethers.Signer | null = null;

export function setBackendSigner(signer: ethers.Signer): void {
  backendSigner = signer;
}

export function getBackendSigner(): ethers.Signer | null {
  return backendSigner;
}
