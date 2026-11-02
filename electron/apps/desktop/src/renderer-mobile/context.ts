/** The signed-in connection for the components that talk to it outside the bridge: the ping, the push, signing out. */
import { createContext, useContext } from 'react';
import type { Connection } from './connection';

export const ConnectionContext = createContext<Connection | null>(null);
export function useConnection(): Connection {
	const connection = useContext(ConnectionContext);
	if (!connection) throw new Error('No connection to the machine.');
	return connection;
}
