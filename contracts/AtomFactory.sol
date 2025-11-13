// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.20;

import {Clones} from "@openzeppelin/contracts/proxy/Clones.sol";
import {Atom} from "./Atom.sol";

contract AtomFactory {
    event AtomDeployed(address addr);

    function create(Atom.Operation[] calldata operations) public {
        Atom instance = new Atom();
        instance.initialize(operations);
        emit AtomDeployed(address(instance));
    }
}
