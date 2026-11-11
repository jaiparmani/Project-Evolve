// Simple integration test for the /todos endpoint
// Requires the server to be running on PORT (default 3001)

const PORT = process.env.PORT || 3001;
const URL = `http://localhost:${PORT}/todos`;

async function runTest() {
  try {
    const response = await fetch(URL);
    if (response.status !== 200) {
      console.error(`❌ Expected status 200, got ${response.status}`);
      process.exit(1);
    }
    const html = await response.text();
    if (!html.includes('<form') || !html.includes('aria-label="Add todo"')) {
      console.error('❌ Form with expected ARIA attributes not found in response');
      process.exit(1);
    }
    console.log('✅ /todos endpoint returned 200 and contains the expected form');
  } catch (err) {
    console.error('❌ Test failed with error:', err);
    process.exit(1);
  }
}

runTest();
