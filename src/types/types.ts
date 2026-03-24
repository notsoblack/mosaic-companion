import React from 'react';

export interface HistoryState {
    past: string[];
    present: string;
    future: string[];
}

export interface SidebarItem {
    id: string;
    label: string;
    icon: string;
    url: string;
}

export enum BrowserTheme {
    LIGHT = 'light',
    DARK = 'dark'
}

export interface Tab {
    id: string;
    title: string;
    history: HistoryState;
    isLoading?: boolean;
    loadProgress?: number; // 0-100
    favicon?: string;
}

export const INTERNAL_HOME_URL = 'browser://home';
export const INTERNAL_SETTINGS_URL = 'browser://settings';
export const INTERNAL_CHAT_URL = 'browser://internal_chat';
export interface AppSettings {
    homeUrl: string;
    customGreeting: string;
    showUrlBar: boolean;
}

// Add definition for Electron webview tag
declare global {
    namespace JSX {
        interface IntrinsicElements {
            webview: React.DetailedHTMLProps<
                React.HTMLAttributes<HTMLElement> & {
                    src?: string;
                    allowpopups?: boolean | string;
                    // Removed webpreferences as we are using defaults
                },
                HTMLElement
            >;
        }
    }
}

// Network API Types (for Builder mode)
export interface NetworkFetchOptions {
    method?: 'GET' | 'POST' | 'PUT' | 'DELETE' | 'PATCH';
    headers?: Record<string, string>;
    body?: string;
    timeout?: number;
}

export interface NetworkFetchResponse {
    success: boolean;
    status?: number;
    headers?: Record<string, string>;
    data?: string;
    error?: string;
}

export interface GraphqlResponse {
    success: boolean;
    status?: number;
    data?: any;
    error?: string;
    raw?: string;
}

export interface ShellExecuteOptions {
    cwd?: string;
    timeout?: number;
}

export interface ShellExecuteResponse {
    success: boolean;
    stdout?: string;
    stderr?: string;
    error?: string;
}

// Internal URLs for new features (from main's architecture)
export const INTERNAL_MCP_URL = 'browser://mcp';
export const INTERNAL_MOSAICBOT_URL = 'browser://mosaicbot';
export const INTERNAL_MULTI_CHAT_URL = 'browser://multi_chat';
export const INTERNAL_WEB3_URL = 'browser://web3';
export const INTERNAL_VAULT_URL = 'browser://vault';
export const INTERNAL_SANDBOX_URL = 'browser://sandbox';
export const INTERNAL_ONBOARDING_URL = 'browser://onboarding';
export const INTERNAL_TOOL_PANEL_PREFIX = 'browser://tool-panel/';
