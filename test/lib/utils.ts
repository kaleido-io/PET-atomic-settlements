import { ContractTransactionReceipt } from "ethers";
import { Poseidon } from "zeto-js";
import { User } from "zeto-solidity/test/lib/utils";

export function parseLockEvents(
    lockContract: any,
    result: ContractTransactionReceipt,
) {
    let events: any[] = [];
    for (const log of result.logs || []) {
        const event = lockContract.interface.parseLog(log as any);
        let eventData: any = null;
        if (event?.name === "LockCreated") {
            eventData = {
                lockId: event?.args.lockId,
                owner: event?.args.owner,
                receiver: event?.args.receiver,
                delegate: event?.args.delegate,
                amount: event?.args.amount,
            };
        } else if (event?.name === "AtomDeployed") {
            eventData = {
                atomInstance: event?.args.addr,
            };
        } else if (event?.name === "AtomBespokeDeployed") {
            eventData = {
                atomInstance: event?.args.addr,
            };
        } else if (event?.name === "OperationSettled") {
            eventData = {
                operationIndex: event?.args.operationIndex,
                lockId: event?.args.lockId,
                data: event?.args.data,
            };
        } else if (event?.name === "OperationSettleFailed") {
            eventData = {
                operationIndex: event?.args.operationIndex,
                lockId: event?.args.lockId,
                reason: event?.args.reason,
            };
        } else if (event?.name === "OperationRolledBack") {
            eventData = {
                operationIndex: event?.args.operationIndex,
                lockId: event?.args.lockId,
                data: event?.args.data,
            };
        } else if (event?.name === "OperationRollbackFailed") {
            eventData = {
                operationIndex: event?.args.operationIndex,
                lockId: event?.args.lockId,
                reason: event?.args.reason,
            };
        }
        if (eventData) {
            events.push(eventData);
        }
    }
    return events;
}
