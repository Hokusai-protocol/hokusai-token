// tools/linear.ts
export const getBacklog = async () => {
    const res = await fetch('https://api.linear.app/graphql', {
      method: 'POST',
      headers: {
        Authorization: process.env.LINEAR_API_KEY || '',
        'Content-Type': 'application/json',
      } as Record<string, string>,
      body: JSON.stringify({
        query: `
          query {
            issues(filter: { 
              project: { name: { eq: "Hokusai smart contracts" } }
            }) {
              nodes {
                id
                title
                description
                state { name }
                labels {
                  nodes { name }
                }
              }
            }
          }
        `,
      }),
    });
  
    const data = await res.json();
    console.log('Linear API response:', JSON.stringify(data, null, 2));
    return data.data?.issues?.nodes;
  };