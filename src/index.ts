import type { Router } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as HttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { v4 as uuidv4 } from 'uuid';

// --- Type Definitions ---

type TransportType = 'stdio' | 'http';

interface BaseServerConfig {
    id: string;
    name: string;
    type: TransportType;
}

interface StdioServerConfig extends BaseServerConfig {
    type: 'stdio';
    command: string;
    args: string[];
    cwd?: string;
    env?: { [key: string]: string };
}

interface HttpServerConfig extends BaseServerConfig {
    type: 'http';
    url: string;
}

type ServerConfig = StdioServerConfig | HttpServerConfig;

interface ActiveConnection {
    id: string;
    client: Client;
    transport: StdioClientTransport | HttpClientTransport;
    config: ServerConfig;
    tools: Tool[];
}

// --- Connection Manager ---

class ConnectionManager {
    private connections: Map<string, ActiveConnection> = new Map();

    public async connect(config: ServerConfig): Promise<ActiveConnection> {
        if (this.connections.has(config.id)) {
            throw new Error(`Server with id ${config.id} is already connected.`);
        }

        const client = new Client({ name: 'mcp-intermediary-client', version: '1.0.0' });
        let transport: StdioClientTransport | HttpClientTransport;

        console.log(`[MCP Intermediary] Attempting to connect to ${config.name} via ${config.type}`);

        try {
            if (config.type === 'stdio') {
                // Correct constructor for StdioClientTransport
                transport = new StdioClientTransport({
                    command: config.command,
                    args: config.args,
                    cwd: config.cwd,
                    env: config.env,
                });
            } else if (config.type === 'http') {
                // Correct constructor for HttpClientTransport
                transport = new HttpClientTransport(new URL(config.url));
            } else {
                throw new Error(`Unsupported transport type: ${(config as any).type}`);
            }

            await client.connect(transport);
            const { tools } = await client.listTools();
            const connection: ActiveConnection = { id: config.id, client, transport, config, tools };
            this.connections.set(config.id, connection);

            console.log(`[MCP Intermediary] Successfully connected to ${config.name} with ${tools.length} tools.`);
            return connection;
        } catch (error: any) {
            console.error(`[MCP Intermediary] Failed to connect to ${config.name}:`, error);
            throw error;
        }
    }

    public async disconnect(id: string): Promise<void> {
        const connection = this.connections.get(id);
        if (!connection) {
            throw new Error(`No active connection found with id ${id}.`);
        }

        try {
            await connection.client.close();
            this.connections.delete(id);
            console.log(`[MCP Intermediary] Successfully disconnected from ${connection.config.name}.`);
        } catch (error: any) {
            console.error(`[MCP Intermediary] Error while disconnecting from ${connection.config.name}:`, error);
            this.connections.delete(id);
            throw error;
        }
    }

    public getConnection(id: string): ActiveConnection | undefined {
        return this.connections.get(id);
    }

    public listConnections(): ServerConfig[] {
        return Array.from(this.connections.values()).map(conn => conn.config);
    }
}


// --- Plugin Definition ---

const info = {
    name: 'MCP Intermediary',
    id: 'mcp-intermediary',
    description: 'Manages and intermediates MCP tool calls.',
    version: '1.0.0',
};

const init = async (router: Router) => {
    console.log('[MCP Intermediary] Backend plugin initializing...');

    const connectionManager = new ConnectionManager();
    const wss = new WebSocketServer({ port: 8081 });

    wss.on('listening', () => {
        console.log('[MCP Intermediary] WebSocket server listening on port 8081.');
    });

    wss.on('connection', (ws: WebSocket) => {
        console.log('[MCP Intermediary] Frontend client connected via WebSocket.');

        ws.on('message', async (message: string) => {
            try {
                const data = JSON.parse(message.toString());
                const { action, payload, requestId } = data;

                const sendResponse = (data: any) => ws.send(JSON.stringify(data));
                
                switch (action) {
                    case 'connect':
                        try {
                            const config: ServerConfig = { ...payload, id: payload.id || uuidv4() };
                            const connection = await connectionManager.connect(config);
                            sendResponse({ 
                                status: 'success', 
                                action: 'connect', 
                                requestId, 
                                data: { 
                                    id: config.id,
                                    tools: connection.tools,
                                },
                            });
                        } catch (error: any) {
                            sendResponse({ status: 'error', action, requestId, message: error.message });
                        }
                        break;

                    case 'disconnect':
                        try {
                            await connectionManager.disconnect(payload.id);
                            sendResponse({ status: 'success', action, requestId, data: { id: payload.id } });
                        } catch (error: any) {
                            sendResponse({ status: 'error', action, requestId, message: error.message });
                        }
                        break;
                    
                    case 'listConnections':
                        const connections = connectionManager.listConnections();
                        sendResponse({ status: 'success', action, requestId, data: connections });
                        break;

                    case 'callTool':
                        try {
                            const { serverId, toolName, args } = payload;
                            const connection = connectionManager.getConnection(serverId);
                            if (!connection) {
                                throw new Error(`Server with id ${serverId} not found or not connected.`);
                            }
                            const result = await connection.client.callTool({ name: toolName, arguments: args });
                            sendResponse({ status: 'success', action, requestId, data: result });
                        } catch (error: any) {
                            sendResponse({ status: 'error', action, requestId, message: error.message });
                        }
                        break;
                    
                    default:
                        sendResponse({ status: 'error', action, requestId, message: `Unknown action: ${action}` });
                }
            } catch (error: any) {
                console.error('[MCP Intermediary] Error processing WebSocket message:', error);
                ws.send(JSON.stringify({ status: 'error', message: 'Invalid message format.' }));
            }
        });

        ws.on('close', () => {
            console.log('[MCP Intermediary] Frontend client disconnected.');
        });
    });

    wss.on('error', (error: any) => {
        console.error('[MCP Intermediary] WebSocket server error:', error);
    });

    console.log('[MCP Intermediary] Backend plugin initialized successfully.');
};

module.exports = { info, init };
