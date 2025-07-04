import type { Router } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import type { Tool } from '@modelcontextprotocol/sdk/types.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { StreamableHTTPClientTransport as HttpClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import { v4 as uuidv4 } from 'uuid';
import fs from 'fs/promises';
import path from 'path';

// Use __dirname which is available in CommonJS runtime environment
const CONFIG_PATH = path.join(__dirname, 'mcp-servers.json');


// --- Type Definitions ---
type TransportType = 'stdio' | 'http' | 'sse';

interface BaseServerConfig {
    id: string;
    name: string;
    type: TransportType;
    enabled: boolean;
}
interface StdioServerConfig extends BaseServerConfig { type: 'stdio'; command: string; args: string[]; cwd?: string; env?: { [key: string]: string }; }
interface HttpServerConfig extends BaseServerConfig { type: 'http'; url: string; }
interface SseServerConfig extends BaseServerConfig { type: 'sse'; url: string; }
type ServerConfig = StdioServerConfig | HttpServerConfig | SseServerConfig;

interface ActiveConnection {
    id: string;
    client: Client;
    config: ServerConfig;
    tools: Tool[];
}

// --- Managers ---

class ServerConfigManager {
    private servers: ServerConfig[] = [];

    async load() {
        try {
            const data = await fs.readFile(CONFIG_PATH, 'utf-8');
            this.servers = JSON.parse(data);
            console.log(`[MCP Intermediary] Loaded ${this.servers.length} server configurations from ${CONFIG_PATH}`);
        } catch (error: any) {
            if (error.code === 'ENOENT') {
                console.log('[MCP Intermediary] No config file found. Starting with empty configuration.');
                this.servers = [];
            } else {
                console.error('[MCP Intermediary] Error loading config file:', error);
            }
        }
    }

    async save() {
        try {
            await fs.writeFile(CONFIG_PATH, JSON.stringify(this.servers, null, 2));
        } catch (error: any) {
            console.error('[MCP Intermediary] Error saving config file:', error);
        }
    }

    getServers() { return this.servers; }
    
    addServer(config: Omit<ServerConfig, 'id' | 'enabled'>) {
        const newServer = { ...config, id: uuidv4(), enabled: false } as ServerConfig;
        this.servers.push(newServer);
        this.save();
        return newServer;
    }

    updateServer(config: ServerConfig) {
        const index = this.servers.findIndex(s => s.id === config.id);
        if (index !== -1) {
            // Preserve enabled status unless explicitly provided
            const existingServer = this.servers[index];
            this.servers[index] = { ...existingServer, ...config };
            this.save();
            return this.servers[index];
        }
        return null;
    }

    updateEnabledStatus(id: string, enabled: boolean) {
        const index = this.servers.findIndex(s => s.id === id);
        if (index !== -1) {
            this.servers[index].enabled = enabled;
            this.save();
        }
    }

    removeServer(id: string) {
        const index = this.servers.findIndex(s => s.id === id);
        if (index !== -1) {
            this.servers.splice(index, 1);
            this.save();
            return true;
        }
        return false;
    }
}

class ConnectionManager {
    private connections: Map<string, ActiveConnection> = new Map();

    public async connect(config: ServerConfig): Promise<ActiveConnection> {
        if (this.connections.has(config.id)) throw new Error(`Server with id ${config.id} is already connected.`);
        
        const client = new Client({ name: 'mcp-intermediary-client', version: '1.0.0' });
        let transport: StdioClientTransport | HttpClientTransport | SSEClientTransport;

        console.log(`[MCP Intermediary] Attempting to connect to ${config.name} via ${config.type}`);

        if (config.type === 'stdio') {
            transport = new StdioClientTransport({ command: config.command, args: config.args, cwd: config.cwd, env: config.env });
        } else if (config.type === 'http') {
            transport = new HttpClientTransport(new URL(config.url));
        } else if (config.type === 'sse') {
            transport = new SSEClientTransport(new URL(config.url));
        } else {
            throw new Error(`Unsupported transport type: ${(config as any).type}`);
        }

        await client.connect(transport);
        const { tools } = await client.listTools();
        const connection: ActiveConnection = { id: config.id, client, config, tools };
        this.connections.set(config.id, connection);

        console.log(`[MCP Intermediary] Successfully connected to ${config.name} with ${tools.length} tools.`);
        return connection;
    }

    public async disconnect(id: string): Promise<void> {
        const connection = this.connections.get(id);
        if (!connection) throw new Error(`No active connection found with id ${id}.`);
        await connection.client.close();
        this.connections.delete(id);
        console.log(`[MCP Intermediary] Successfully disconnected from ${connection.config.name}.`);
    }

    public getConnection(id: string) { return this.connections.get(id); }
    public getActiveConnectionIds() { return Array.from(this.connections.keys()); }
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

    const configManager = new ServerConfigManager();
    await configManager.load();
    
    const connectionManager = new ConnectionManager();
    const wss = new WebSocketServer({ port: 8081 });

    const broadcastServers = () => {
        const servers = configManager.getServers();
        const activeIds = connectionManager.getActiveConnectionIds();
        const serverStatus = servers.map(s => {
            const connection = connectionManager.getConnection(s.id);
            return { 
                ...s, 
                status: activeIds.includes(s.id) ? 'connected' : 'disconnected',
                tools: connection ? connection.tools : [],
            };
        });
        
        wss.clients.forEach(client => {
            if (client.readyState === WebSocket.OPEN) {
                client.send(JSON.stringify({ action: 'serversUpdated', data: serverStatus }));
            }
        });
    };

    wss.on('connection', (ws: WebSocket) => {
        console.log('[MCP Intermediary] Frontend client connected.');
        broadcastServers();

        ws.on('message', async (message: string) => {
            let data: any;
            try {
                data = JSON.parse(message.toString());
                const { action, payload, requestId } = data;
                const sendResponse = (responseData: any) => ws.send(JSON.stringify({ ...responseData, requestId }));

                switch (action) {
                    case 'addServer':
                        configManager.addServer(payload);
                        broadcastServers();
                        break;
                    case 'updateServer':
                        configManager.updateServer(payload);
                        broadcastServers();
                        break;
                    case 'removeServer':
                        configManager.removeServer(payload.id);
                        broadcastServers();
                        break;
                    case 'connect': {
                        const config = configManager.getServers().find(s => s.id === payload.id);
                        if (!config) throw new Error('Server config not found');
                        const connection = await connectionManager.connect(config);
                        configManager.updateEnabledStatus(config.id, true);
                        sendResponse({ status: 'success', data: { id: config.id, tools: connection.tools } });
                        broadcastServers();
                        break;
                    }
                    case 'disconnect': {
                        await connectionManager.disconnect(payload.id);
                        configManager.updateEnabledStatus(payload.id, false);
                        sendResponse({ status: 'success' });
                        broadcastServers();
                        break;
                    }
                    case 'callTool': {
                        const { serverId, toolName, args } = payload;
                        const connection = connectionManager.getConnection(serverId);
                        if (!connection) throw new Error(`Server with id ${serverId} not found or not connected.`);
                        const result = await connection.client.callTool({ name: toolName, arguments: args });
                        sendResponse({ status: 'success', data: result });
                        break;
                    }
                }
            } catch (error: any) {
                console.error('[MCP Intermediary] Error processing message:', error);
                if (data && data.requestId) ws.send(JSON.stringify({ status: 'error', message: error.message, requestId: data.requestId }));
            }
        });
        ws.on('close', () => console.log('[MCP Intermediary] Frontend client disconnected.'));
    });

    wss.on('error', (error: any) => console.error('[MCP Intermediary] WebSocket server error:', error));

    // Auto-connect to enabled servers on startup
    const autoConnect = async () => {
        console.log('[MCP Intermediary] Auto-connecting to enabled servers...');
        for (const server of configManager.getServers()) {
            if (server.enabled) {
                try {
                    await connectionManager.connect(server);
                } catch (error: any) {
                    console.error(`[MCP Intermediary] Failed to auto-connect to ${server.name}: ${error.message}`);
                }
            }
        }
        broadcastServers();
    };

    autoConnect();

    console.log('[MCP Intermediary] Backend plugin initialized successfully.');
};

module.exports = { info, init };
