import { createContext, useContext } from 'react';

/** Actions provided by the editor page to deeply nested canvas components. */
export interface CanvasActions {
  executeWorkflow(): void;
  executeStep(nodeName: string): void;
  stopExecution(): void;
  save(): Promise<boolean>;
}

const noop: CanvasActions = {
  executeWorkflow() {},
  executeStep() {},
  stopExecution() {},
  save: async () => false,
};

export const CanvasActionsContext = createContext<CanvasActions>(noop);
export const useCanvasActions = () => useContext(CanvasActionsContext);
