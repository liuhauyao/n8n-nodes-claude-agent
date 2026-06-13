module.exports = {
	apps: [
		{
			name: 'claude-agent-sidecar',
			script: 'dist/index.js',
			cwd: __dirname,
			instances: 1,
			autorestart: true,
			max_memory_restart: '2G',
			env: {
				CLAUDE_AGENT_SIDECAR_HOST: '127.0.0.1',
				CLAUDE_AGENT_SIDECAR_PORT: '18790',
				SIDECAR_IDLE_TIMEOUT_MS: '1800000',
				SIDECAR_MAX_SESSIONS: '64',
				SIDECAR_MESSAGE_TIMEOUT_MS: '600000',
			},
		},
	],
};
