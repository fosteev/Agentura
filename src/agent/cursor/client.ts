import {
  AcpRpcClient,
  AcpRpcError,
  MAX_LINE_BYTES,
  redact,
  type AcpRpcClientOptions,
  type RpcId,
  type RpcProcess,
} from '../acp/client';
import { permissionRefusal } from './protocol';

export { MAX_LINE_BYTES, redact };
export type { RpcId, RpcProcess };

/** Ошибка JSON-RPC Cursor ACP: общий `AcpRpcError` с меткой `Cursor` (`name` — `CursorRpcError`). */
export const CursorRpcError = AcpRpcError;
export type CursorRpcError = AcpRpcError;

export type CursorRpcClientOptions = Omit<AcpRpcClientOptions, 'engine'>;

/**
 * Транспорт Cursor ACP — общий `AcpRpcClient` (`src/agent/acp/client.ts`) с меткой `Cursor` в ошибках
 * и отказом на неразобранное разрешение формой Cursor (`reject-once`).
 */
export class CursorRpcClient extends AcpRpcClient {
  constructor(process: RpcProcess, options: CursorRpcClientOptions = {}) {
    super(process, { refusePermission: () => permissionRefusal(), ...options, engine: 'Cursor' });
  }
}
