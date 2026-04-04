# WhatsApp Automation Machine

A service to manage working hours and automate basic tasks via WhatsApp.

## Setup
1.  **Environment Variables:** Create a `.env` file based on `.env.example`.
    ```
    SSH_BASE=ssh -i /path/to/key ubuntu@host
    MENTION_KEYWORD=@siddhant
    ```
2.  **Project Mapping:** Update `src/config/projects-map.json` to map GitLab repository URLs to server paths.
3.  **Install Dependencies:**
    ```bash
    npm install
    ```
4.  **Run Service:**
    ```bash
    npm start
    ```
5.  **Scan QR Code:** Scan the generated QR code with your WhatsApp app.

## Available Actions
### 1. `make_live`
- **Template:** `@siddhant make_live test <repo_link> <branch_name>`
- **Description:** Deploys a specific branch of a GitLab repository to the test server.
- **Workflow:** Connects via SSH, fetches updates, and checks out the specified branch.

## How to create a new action
The project follows a scalable and extensible action pattern.

1.  **Define the Action:** Create a new file in `src/actions/` (e.g., `StatusAction.ts`).
2.  **Implement the `Action` interface:**
    ```typescript
    import { Action } from './Action.js';
    import { InboundMessage } from '../services/InboundService.js';

    export class StatusAction implements Action {
      name = 'status';
      template = 'status <env>';
      description = 'Checks the status of the server.';

      matches(message: InboundMessage): boolean {
        // Implement matching logic (e.g., check message text)
        return message.isMentioned && message.text.includes('status');
      }

      async execute(message: InboundMessage): Promise<string> {
        // Implement action logic
        return "Server is online!";
      }
    }
    ```
3.  **Register the Action:** Add your new action to the `actions` array in `src/actions/ActionDispatcher.ts`.
    ```typescript
    import { StatusAction } from './StatusAction.js';
    // ...
    private actions: Action[] = [
      new MakeLiveAction(),
      new StatusAction(), // Registered here
    ];
    ```

## Testing
- **Unit Testing:** You can test individual actions by mocking the `InboundMessage` context.
- **Live Testing:** Use the generated QR code to connect your account and send messages to a test group where you mention the bot.
