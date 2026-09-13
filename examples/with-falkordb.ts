/** Direct graph API example; writes two sample nodes in an isolated example graph. */
import { FalkorDBClient } from '../dist/index.js';
const url = process.env.GRAPH_URL;
if (!url) throw new Error('Set GRAPH_URL to an isolated FalkorDB Redis-protocol endpoint.');
const graph = new FalkorDBClient(url, 'mnemosyne_example_graph');
const deadline = setTimeout(() => { console.error('Graph example exceeded 15 seconds.'); process.exit(1); }, 15_000);
try {
  await graph.connect();
  await graph.addEntity('Example Catalogue', 'Project');
  await graph.addEntity('Example Owner', 'Reviewer');
  await graph.addRelationship('Example Catalogue', 'Example Owner', 'REQUIRES_APPROVAL');
  // This is graph lookup, not a demonstrated multi-hop reasoning result.
  console.log(await graph.findRelated('Example Catalogue', 1));
} finally {
  await graph.disconnect();
  clearTimeout(deadline);
}
