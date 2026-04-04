import { MakeLiveAction } from './actions/MakeLiveAction.js';
import { InboundMessage } from './services/InboundService.js';

async function testMakeLive() {
  const action = new MakeLiveAction();
  
  const mockMessage: InboundMessage = {
    sender: 'test-user',
    groupID: 'test-group',
    text: '@siddhant make_live test https://gitlab.com/example/repo1 master',
    isMentioned: true,
    timestamp: Date.now()
  };

  console.log('--- Testing Action Match ---');
  const isMatch = action.matches(mockMessage);
  console.log(`Is Match? ${isMatch}`);

  if (isMatch) {
    console.log('\n--- Testing Action Execution (Simulated) ---');
    // Note: This will actually attempt to run SSH if you have a valid .env and network access.
    // For a pure unit test, we should mock ShellExecutor.
    const result = await action.execute(mockMessage);
    console.log(`Result:\n${result}`);
  }
}

testMakeLive().catch(console.error);
