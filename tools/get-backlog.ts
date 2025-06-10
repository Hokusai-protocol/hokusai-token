// @ts-nocheck
const { getBacklog } = require('./linear-tasks.ts');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

async function main() {
  try {
    const backlog = await getBacklog();
    console.log('Backlog Items:');
    backlog.forEach((issue) => {
      console.log('\n---');
      console.log(`Title: ${issue.title}`);
      console.log(`Description: ${issue.description || 'No description'}`);
      console.log('Labels:', issue.labels.nodes.map((label) => label.name).join(', '));
    });
  } catch (error) {
    console.error('Error fetching backlog:', error);
  }
}

main(); 