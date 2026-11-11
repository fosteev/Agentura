import type { AgentProvider } from '../agent/types';

export type TaskPickerError =
  'invalid' | 'no-source' | 'unavailable' | 'timeout' | 'stale' | 'failed';
export interface PickerInstance {
  id: string;
  name: string;
  baseUrl: string;
}
export interface PickerChat {
  id: string;
  provider: AgentProvider;
  title: string;
  updatedAt: number;
  archived: boolean;
}
export type TaskPickerResult =
  | { kind: 'error'; code: TaskPickerError }
  | { kind: 'instances'; instances: PickerInstance[] }
  | {
      kind: 'found';
      taskKey: string;
      key: string;
      title: string;
      status?: string;
      instance: PickerInstance;
      chats: PickerChat[];
      existing: boolean;
    };
export type TaskPickerAction = {
  requestId: number;
  mode: 'open' | 'create';
  sessionId?: string;
  provider?: AgentProvider;
  prompt?: string;
};
export type TaskPickerRequest =
  | { type: 'task.picker.find'; requestId: number; query: string; instanceId?: string }
  | ({ type: 'task.picker.act' } & TaskPickerAction)
  | { type: 'task.picker.cancel' };
export type TaskPickerResponse =
  | { type: 'task.picker.result'; requestId: number; result: TaskPickerResult }
  | { type: 'task.picker.done'; requestId: number; error?: TaskPickerError };
