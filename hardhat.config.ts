// zeto-js / zeto-solidity (loadProvingKeys) expect these; defaults match local
// zkp layout — override in the shell or .env if needed.
process.env.CIRCUITS_ROOT =
  process.env.CIRCUITS_ROOT ?? "/Users/jimzhang/Documents/zkp/circuits/";
process.env.PROVING_KEYS_ROOT =
  process.env.PROVING_KEYS_ROOT ?? "/Users/jimzhang/Documents/zkp/proving-keys/";

import { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import "@openzeppelin/hardhat-upgrades";
import "@fhevm/hardhat-plugin";

const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.27",
    settings: {
      optimizer: {
        enabled: true,
        runs: 25,
      },
      viaIR: true,
      evmVersion: 'cancun',
    },
  },
};

export default config;
