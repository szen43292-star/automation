import { useCallback, useEffect, useRef } from 'react';
import { toast } from 'sonner';
import { useNavigate } from 'react-router-dom';
import { ApiError, endpoints } from '../../lib/api';
import { push, type PushMessage } from '../../lib/push';
import { useEditor } from '../../stores/editor';
import { STICKY_TYPE } from '../../stores/nodeTypes';
import type { CanvasActions } from '../../components/canvas/actions';

/** Save, run, stop – wired to the push channel with a polling fallback. */
export function useEditorActions(): CanvasActions {
  const navigate = useNavigate();
  const awaitingRun = useRef(false);
  const buffer = useRef<PushMessage[]>([]);
  const workflowId = useEditor((s) => s.workflowId);
  const executionId = useEditor((s) => s.executionId);
  const executionStatus = useEditor((s) => s.executionStatus);

  const loadResult = useCallback(async (id: string) => {
    try {
      const detail = await endpoints.execution(id);
      const state = useEditor.getState();
      if (state.executionId !== id) return;
      state.applyExecution(detail);
      if (detail.status === 'error' && detail.errorMessage) {
        toast.error('Workflow execution failed', { description: detail.errorMessage });
      } else if (detail.status === 'canceled') {
        toast.info('Execution stopped');
      }
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, []);

  // Live updates for this workflow.
  useEffect(() => {
    if (!workflowId) return;
    const unsubscribe = push.subscribe(`workflow:${workflowId}`);
    const off = push.on((message) => {
      if (!('data' in message) || !message.data || !('workflowId' in message.data)) return;
      if (message.data.workflowId !== workflowId) return;
      if (message.type === 'workflowUpdated') return;
      if (awaitingRun.current) {
        buffer.current.push(message);
        return;
      }
      useEditor.getState().applyPush(message);
      if (
        message.type === 'executionFinished' &&
        message.data.executionId === useEditor.getState().executionId
      ) {
        void loadResult(message.data.executionId);
      }
    });
    return () => {
      off();
      unsubscribe();
    };
  }, [workflowId, loadResult]);

  // Polling fallback when the WebSocket is down.
  useEffect(() => {
    if (executionStatus !== 'running' || !executionId) return;
    const timer = setInterval(async () => {
      if (push.connected) return;
      try {
        const detail = await endpoints.execution(executionId);
        if (!detail.running) void loadResult(executionId);
      } catch {
        /* keep polling */
      }
    }, 2000);
    return () => clearInterval(timer);
  }, [executionStatus, executionId, loadResult]);

  const save = useCallback(async (): Promise<boolean> => {
    const state = useEditor.getState();
    if (state.readOnly) return false;
    const body = {
      name: state.name.trim() || 'My workflow',
      nodes: state.nodes,
      connections: state.connections,
      settings: state.settings,
      pinData: state.pinData,
    };
    try {
      if (!state.workflowId) {
        const created = await endpoints.createWorkflow(body);
        state.markSaved(created);
        navigate(`/workflow/${created.id}`, { replace: true });
      } else {
        const updated = await endpoints.updateWorkflow(state.workflowId, {
          ...body,
          versionId: state.versionId ?? undefined,
        });
        useEditor.getState().markSaved(updated);
      }
      toast.success('Saved');
      return true;
    } catch (error) {
      if (error instanceof ApiError && error.status === 409) {
        toast.error('Save conflict', {
          description: error.message,
          action: { label: 'Reload', onClick: () => window.location.reload() },
          duration: 15000,
        });
      } else {
        toast.error('Could not save the workflow', { description: (error as Error).message });
      }
      return false;
    }
  }, [navigate]);

  const run = useCallback(
    async (destinationNode?: string) => {
      const state = useEditor.getState();
      if (state.executionStatus === 'running' || state.readOnly) return;
      if (!state.nodes.some((n) => n.type !== STICKY_TYPE)) {
        toast.error('Add a node first');
        return;
      }
      let id = state.workflowId;
      if (!id) {
        if (!(await save())) return;
        id = useEditor.getState().workflowId;
      }
      if (!id) return;
      awaitingRun.current = true;
      buffer.current = [];
      try {
        const latest = useEditor.getState();
        const { executionId: newId } = await endpoints.run(id, {
          workflowData: {
            name: latest.name,
            nodes: latest.nodes,
            connections: latest.connections,
            settings: latest.settings,
            pinData: latest.pinData,
          },
          destinationNode,
          // Partial execution: reuse the outputs of the last run for unchanged nodes.
          ...(destinationNode && latest.runData && Object.keys(latest.runData).length
            ? { runData: latest.runData, dirtyNodes: latest.dirtyNodes }
            : {}),
        });
        useEditor.getState().startExecution(newId);
        awaitingRun.current = false;
        // Replay events that arrived before the HTTP response.
        for (const message of buffer.current) {
          useEditor.getState().applyPush(message);
          if (message.type === 'executionFinished' && message.data.executionId === newId)
            void loadResult(newId);
        }
        buffer.current = [];
      } catch (error) {
        awaitingRun.current = false;
        toast.error('Could not start the execution', { description: (error as Error).message });
      }
    },
    [save, loadResult],
  );

  const stop = useCallback(async () => {
    const id = useEditor.getState().executionId;
    if (!id) return;
    try {
      await endpoints.stopExecution(id);
    } catch (error) {
      toast.error((error as Error).message);
    }
  }, []);

  const attachExecution = useCallback(
    (executionId: string) => {
      useEditor.getState().startExecution(executionId);
      // The run may already be over by the time we hear about it.
      setTimeout(async () => {
        try {
          const detail = await endpoints.execution(executionId);
          if (!detail.running && useEditor.getState().executionId === executionId)
            void loadResult(executionId);
        } catch {
          /* push events will follow */
        }
      }, 300);
    },
    [loadResult],
  );

  return {
    attachExecution,
    save,
    executeWorkflow: () => void run(),
    executeStep: (nodeName: string) => void run(nodeName),
    stopExecution: () => void stop(),
  };
}
