export interface EnvVariableConfig {
  key: string;
  description: string;
  default?: string;
  secret?: boolean;
}

export const ENV_VARIABLES: EnvVariableConfig[] = [
  {
    key: 'SSH_KEY_PATH',
    description: 'Absolute path to the SSH private key used for deployment',
    default: '/path/to/your/key.pem'
  },
  {
    key: 'SSH_USER',
    description: 'SSH username for the deployment server (e.g., ubuntu)',
    default: 'ubuntu'
  },
  {
    key: 'SSH_HOST',
    description: 'Hostname or IP address of the deployment server',
    default: 'testflask.beyondchats.com'
  },
  {
    key: 'MENTION_KEYWORD',
    description: 'The keyword used to trigger the bot in messages (e.g., @siddhant)',
    default: '@siddhant'
  },
  {
    key: 'GEMINI_API_KEY',
    description: 'Google AI Studio API key for Gemini model calls',
    default: '',
    secret: true
  },
  {
    key: 'LLM_MODEL_FAST',
    description: 'Gemini model used for cheap/fast classification calls',
    default: 'gemini-2.5-flash'
  },
  {
    key: 'LLM_MODEL_SMART',
    description: 'Gemini model used when reasoning matters (EOD aggregate, plan-day)',
    default: 'gemini-2.5-pro'
  },
  {
    key: 'LLM_DRY_RUN',
    description: 'When true, GeminiClient returns canned shapes without hitting the API',
    default: 'false'
  },
  {
    key: 'SCHEDULER_TZ',
    description: 'IANA timezone for cron schedules (e.g., Asia/Kolkata)',
    default: 'Asia/Kolkata'
  },
  {
    key: 'WORKING_DAYS',
    description: 'Comma-separated list of weekdays the bot operates on',
    default: 'mon,tue,wed,thu,fri'
  },
  {
    key: 'WORKING_HOURS_START',
    description: 'Start of working hours in HH:MM (in SCHEDULER_TZ)',
    default: '09:00'
  },
  {
    key: 'WORKING_HOURS_END',
    description: 'End of working hours in HH:MM (in SCHEDULER_TZ)',
    default: '19:00'
  },
  {
    key: 'ENABLED_HOOKS',
    description: 'Comma-separated list of Hook class names to enable',
    default: 'PersistMessageHook'
  },
  {
    key: 'ENABLED_JOBS',
    description: 'Comma-separated list of Job class names to enable',
    default: 'PruneMessagesJob'
  },
  {
    key: 'DB_PATH',
    description: 'Path to the SQLite database file',
    default: 'data/machine.db'
  },
  {
    key: 'MESSAGE_RETENTION_DAYS',
    description: 'How many days of messages to keep before PruneMessagesJob deletes them',
    default: '7'
  },
  {
    key: 'GITLAB_BASE_URL',
    description: 'GitLab base URL (e.g. https://gitlab.com)',
    default: 'https://gitlab.com'
  },
  {
    key: 'GITLAB_TOKEN',
    description: 'GitLab personal access token with read_api scope',
    default: '',
    secret: true
  },
  {
    key: 'GITLAB_PROJECT_IDS',
    description: 'Comma-separated GitLab numeric project IDs to monitor for staging/prod MRs',
    default: ''
  },
  {
    key: 'GITLAB_TARGET_BRANCHES',
    description: 'Comma-separated MR target branches that count as backlog (e.g. staging,prod)',
    default: 'staging,prod'
  },
  {
    key: 'PRODUCT_SHEET_ID',
    description: 'Google Sheet ID for the product backlog',
    default: ''
  },
  {
    key: 'PRODUCT_SHEET_RANGE',
    description: 'A1 range to read (e.g. "All Tasks!A:Z")',
    default: 'Sheet1!A:Z'
  },
  {
    key: 'PRODUCT_SHEET_STATUS_COL',
    description: 'Header name of the status column (case-sensitive)',
    default: 'Status'
  },
  {
    key: 'PRODUCT_SHEET_TITLE_COL',
    description: 'Header name of the column to use as the backlog item title',
    default: 'SA'
  },
  {
    key: 'PRODUCT_SHEET_DESCRIPTION_COL',
    description: 'Header name of the column with the longer task description (optional)',
    default: 'Task Details'
  },
  {
    key: 'PRODUCT_SHEET_ID_COL',
    description: 'Optional: header name of a stable id column. Falls back to sheetId:rowIndex if blank.',
    default: ''
  },
  {
    key: 'MENTION_REPLY_SLA_HOURS',
    description: 'Working hours after which an unanswered mention surfaces in backlog',
    default: '4'
  },
  {
    key: 'WA_CLASSIFY_BATCH_SIZE',
    description: 'Max messages classified per ClassifyWaInboxJob tick',
    default: '20'
  },
  {
    key: 'WA_CLASSIFY_GROUPS',
    description: 'Comma-separated team.json group labels to scan for tasks/connects',
    default: 'org-level,csm,bugs'
  },
  {
    key: 'WA_PREDOWNLOAD_MEDIA',
    description: 'Pre-download images at message-receipt time so vision classification still works after WA media URLs expire (~14d)',
    default: 'false'
  },
  {
    key: 'MR_REVIEW_REPO_DIR',
    description: 'Where bare repo caches + worktrees live (per-project subdirs).',
    default: 'data/repos'
  },
  {
    key: 'MR_REVIEW_MAX_CONCURRENT',
    description: 'Max simultaneous Claude Code review sessions. Excess reviews queue.',
    default: '3'
  },
  {
    key: 'MR_REVIEW_DEFAULT_MODEL',
    description: 'Default Claude model for MR reviews (claude-sonnet-4-6 / claude-opus-4-7 / claude-haiku-4-5).',
    default: 'claude-sonnet-4-6'
  },
  {
    key: 'MR_REVIEW_DEFAULT_LEVEL',
    description: 'Default review depth: critical_only | critical_plus_correctness | thorough',
    default: 'critical_only'
  },
  {
    key: 'MR_REVIEW_GIT_USER_NAME',
    description: 'git user.name for AI-review commits',
    default: 'BeyondChats Bot'
  },
  {
    key: 'MR_REVIEW_GIT_USER_EMAIL',
    description: 'git user.email for AI-review commits',
    default: 'bot@beyondchats.com'
  },
  {
    key: 'CLAUDE_CLI',
    description: 'Path to the `claude` CLI used for MR reviews. Reuses ~/.claude credentials of the spawning user.',
    default: 'claude'
  },
  {
    key: 'WEB_HOST',
    description: 'Web dashboard bind host (default 127.0.0.1; loopback only)',
    default: '127.0.0.1'
  },
  {
    key: 'WEB_PORT',
    description: 'Web dashboard port',
    default: '7777'
  },
  {
    key: 'WEB_USER',
    description: 'Optional HTTP basic-auth username for the dashboard. Leave blank to disable auth (loopback only).',
    default: ''
  },
  {
    key: 'WEB_PASS',
    description: 'Optional HTTP basic-auth password for the dashboard.',
    default: '',
    secret: true
  }
];
