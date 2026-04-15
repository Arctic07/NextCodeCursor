import * as vscode from 'vscode'

export interface ServerConfig {
  host: string
  port: number
  autoStart: boolean
  collectorPort: number
}

function cfg(): vscode.WorkspaceConfiguration {
  return vscode.workspace.getConfiguration('cursor2plus')
}

export function getServerConfig(): ServerConfig {
  const c = cfg()
  return {
    host: c.get<string>('server.host', '127.0.0.1'),
    port: c.get<number>('server.port', 9960),
    autoStart: c.get<boolean>('server.autoStart', true),
    collectorPort: c.get<number>('collector.port', 14800),
  }
}
