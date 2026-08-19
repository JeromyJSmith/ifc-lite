/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite workbench-graph <file.ifc> [--json]
 *
 * Parse an IFC via the CLI loader and emit Marpa workbench graph JSON
 * (nodes + relating/related edges from RelationshipGraph).
 */
import { createHeadlessContext } from '../loader.js';
import { buildWorkbenchGraphFromStore } from '../lib/workbench-graph.js';
import { printJson, fatal, hasFlag } from '../output.js';

export async function workbenchGraphCommand(args: string[]): Promise<void> {
  const filePath = args.find((a) => !a.startsWith('-'));
  if (!filePath) fatal('Usage: ifc-lite workbench-graph <file.ifc> [--json]');

  const jsonOutput = hasFlag(args, '--json');
  const t0 = performance.now();
  const { store } = await createHeadlessContext(filePath);
  const parseMs = Math.round(performance.now() - t0);

  const graph = buildWorkbenchGraphFromStore(store, { sourcePath: filePath, parseMs });

  if (jsonOutput) {
    printJson(graph);
  } else {
    process.stdout.write(JSON.stringify(graph, null, 2) + '\n');
  }
}