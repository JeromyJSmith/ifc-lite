#!/usr/bin/env node
/* This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at https://mozilla.org/MPL/2.0/. */

/**
 * ifc-lite CLI — BIM toolkit for the terminal
 *
 * Query, validate, export, create, merge, convert, diff, and script IFC files
 * from the command line. Designed for both humans and LLM terminals.
 */

import { logger, parseVerbosity } from './logger.js';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

function getVersion(): string {
  try {
    // Try to read from package.json (works in both src/ and dist/)
    const pkgPath = join(__dirname, '..', 'package.json');
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8'));
    return pkg.version ?? '0.4.0';
  } catch {
    return '0.4.0';
  }
}

const VERSION = getVersion();

const HELP = `
  ifc-lite v${VERSION} — BIM toolkit for the terminal

  Usage: ifc-lite <command> [options]

  Commands:
    info      <file.ifc>                          Model summary (schema, entities, storeys)
    query     <file.ifc> [--type T] [--json]      Query entities by type/properties/quantities
    props     <file.ifc> --id <N>                 All properties for a single entity
    export    <file.ifc> --format csv|json|ifc|hbjson  Export data / Honeybee energy model
    diagnose-geometry <file.ifc> [--json]        CSG / opening diagnostics (failures, classification)
                      [--product ID|GUID] [--type T]  Filter worst-hosts detail to one product/type
    ids       <file.ifc> <rules.ids>              Validate against IDS rules
    bcf       <create|list|add-comment>           Work with BCF collaboration files
    clash     <file.ifc> [--matrix] [--bcf F]      Detect geometric clashes between elements
    create    <type> [options] --out F             Create IFC elements (30+ types)
    eval      <file.ifc> "<expression>"           Evaluate SDK expression
    run       <script.js> <file.ifc>              Execute a script against model
    schema                                        Dump SDK API schema (for LLM tools)
    merge     <f1.ifc> <f2.ifc> --out F           Merge multiple IFC files
    convert   <file.ifc> --schema VER --out F     Convert between IFC schema versions
    diff      <f1.ifc> <f2.ifc>                   Compare two IFC files
    validate  <file.ifc>                          Structural validation checks
    bsdd      <class|search|psets|qsets> <arg>     buildingSMART Data Dictionary lookup
    stats     <file.ifc>                          Auto-calculated model KPIs and health check
    workbench-graph <file.ifc> [--json]           Marpa workbench graph (RelationshipGraph JSON)
    mutate    <file.ifc> --id N --set P=V --out F  Modify properties/attributes and save
    generate-spaces <file.ifc> --out F           Derive IfcSpace from walls (slab/roof-aware height)
    ask       <file.ifc> "<question>"            Natural language BIM queries
    view      <file.ifc> [--port N]              Interactive 3D viewer in browser
    analyze   <file.ifc> --viewer <port>        Query + visualize analysis results
    lod       <file.ifc> --level 0|1            Generate lightweight LOD artifacts
    mcp       <file.ifc> [--transport stdio|http] Start an MCP server bound to one or more IFC files
    ext       validate <path>|init <dir>          Manage IFClite extensions (Phase 0 — validate, init)

  Options:
    --help, -h           Show help
    --version, -v        Show version
    --json               Output as JSON (machine-readable)
    --out <file>         Write output to file instead of stdout
    --verbose            Show parser + geometry diagnostics (stderr)
    --quiet              Errors only
    --debug              Verbose + stack traces on error
    --log-level <level>  error|warn|info|debug (explicit wins over shorthands)

  Examples:
    ifc-lite info model.ifc
    ifc-lite query model.ifc --type IfcWall --json
    ifc-lite query model.ifc --type IfcDoor --props --limit 5
    ifc-lite query model.ifc --type IfcWall --materials --classifications --json
    ifc-lite query model.ifc --type IfcWall --all --json
    ifc-lite query model.ifc --type IfcWall --quantity-names
    ifc-lite query model.ifc --type IfcWall --sum GrossSideArea
    ifc-lite query model.ifc --type IfcWall --group-by material --json
    ifc-lite query model.ifc --spatial --summary
    ifc-lite query model.ifc --spatial
    ifc-lite props model.ifc --id 42
    ifc-lite export model.ifc --format csv --type IfcWall --columns Name,Type,GlobalId
    ifc-lite export model.ifc --format json --type IfcWall,IfcDoor
    ifc-lite diagnose-geometry model.ifc --json
    ifc-lite diagnose-geometry model.ifc --type IfcWall
    ifc-lite diagnose-geometry model.ifc --product 0YvCT2_$X3_xJG3rzD8L_8
    ifc-lite ids model.ifc requirements.ids --json
    ifc-lite bcf create --title "Missing door" --out issue.bcf
    ifc-lite clash model.ifc --matrix --json
    ifc-lite clash model.ifc --a "IfcDuct*|IfcPipe*" --b "IfcWall*" --mode clearance --clearance 0.05
    ifc-lite clash model.ifc --matrix --bcf clashes.bcfzip
    ifc-lite create wall --height 3 --thickness 0.2 --start 0,0,0 --end 5,0,0 --out wall.ifc
    ifc-lite create stair --number-of-risers 12 --riser-height 0.175 --width 1.2 --out stair.ifc
    ifc-lite create door --width 0.9 --height 2.1 --position 0,0,0 --out door.ifc
    ifc-lite create i-shape-beam --start 0,0,3 --end 5,0,3 --out beam.ifc
    ifc-lite create wall --from-json --out w.ifc < params.json
    ifc-lite create wall --pset '{"Name":"Pset_WallCommon","Properties":[{"Name":"IsExternal","NominalValue":true}]}' --out w.ifc
    ifc-lite create wall --material '{"Name":"Concrete","Category":"Structural"}' --out w.ifc
    ifc-lite create wall --color 0.8,0.2,0.2 --out w.ifc
    ifc-lite eval model.ifc "bim.query().byType('IfcWall').count()"
    ifc-lite eval model.ifc "bim.storeys().map(s => s.name)"
    ifc-lite run analysis.js model.ifc
    ifc-lite schema
    ifc-lite schema --compact
    ifc-lite merge arch.ifc struct.ifc mep.ifc --out federated.ifc
    ifc-lite convert model.ifc --schema IFC4 --out model-ifc4.ifc
    ifc-lite diff model-v1.ifc model-v2.ifc --json
    ifc-lite diff model-v1.ifc model-v2.ifc --by-entity
    ifc-lite validate model.ifc --json
    ifc-lite bsdd class IfcWall
    ifc-lite bsdd search "concrete wall"
    ifc-lite bsdd psets IfcWall
    ifc-lite ask model.ifc "how many walls?"
    ifc-lite ask model.ifc "window-wall ratio" --json
    ifc-lite ask model.ifc "list materials" --explain
    ifc-lite view model.ifc
    ifc-lite view model.ifc --port 3456
    curl -X POST http://localhost:3456/api/command -H 'Content-Type: application/json' -d '{"action":"colorize","type":"IfcWall","color":[1,0,0,1]}'
    ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --missing "Pset_WallCommon.FireRating" --color red
    ifc-lite analyze model.ifc --viewer 3456 --type IfcSlab --where "GrossArea>100" --color orange --isolate
    ifc-lite analyze model.ifc --viewer 3456 --type IfcWall --heatmap "Qto_WallBaseQuantities.GrossSideArea"
    ifc-lite analyze model.ifc --viewer 3456 --rules rules.json --json
    ifc-lite lod model.ifc --level 0 --out model.lod0.json
    ifc-lite lod model.ifc --level 1 --out model.glb --meta model.lod1.json
    ifc-lite mcp model.ifc
    ifc-lite mcp model.ifc --read-only
    ifc-lite mcp arch.ifc struct.ifc --federate
    ifc-lite mcp model.ifc --transport http --port 8765 --token abc

  Pipe-friendly:
    ifc-lite query model.ifc --type IfcWall --json | jq '.[].name'
    ifc-lite export model.ifc --format csv --type IfcSlab > slabs.csv
    echo '{"Start":[0,0,0],"End":[10,0,0],"Height":3}' | ifc-lite create wall --from-json --out w.ifc

  Create element types:
    wall, slab, column, beam, stair, roof, gable-roof, door, window,
    wall-door, wall-window, ramp, railing, plate, member, footing, pile,
    space, curtain-wall, furnishing, proxy, circular-column,
    hollow-circular-column, i-shape-beam, l-shape-member, t-shape-member,
    u-shape-member, rectangle-hollow-beam

  Learn more: https://ifclite.com
`;

/** Command being executed, captured for the top-level error handler. */
let activeCommand = '';
/** True when --debug was passed (stack traces on error). */
let debugFlag = false;

async function main(): Promise<void> {
  // Global verbosity flags are parsed and STRIPPED before dispatch so a
  // command's positional-argument scan never mistakes them for a file path.
  const verbosity = parseVerbosity(process.argv.slice(2));
  logger.configure({ level: verbosity.level });
  debugFlag = verbosity.debug;
  const args = verbosity.rest;

  if (args.length === 0 || args.includes('--help') || args.includes('-h')) {
    process.stdout.write(HELP + '\n');
    return;
  }

  if (args.includes('--version') || args.includes('-v')) {
    process.stdout.write(`ifc-lite ${VERSION}\n`);
    return;
  }

  const command = args[0];
  activeCommand = command;
  const commandArgs = args.slice(1);

  switch (command) {
    case 'info':
      await (await import('./commands/info.js')).infoCommand(commandArgs);
      break;
    case 'query':
      await (await import('./commands/query.js')).queryCommand(commandArgs);
      break;
    case 'props':
      await (await import('./commands/props.js')).propsCommand(commandArgs);
      break;
    case 'export':
      await (await import('./commands/export.js')).exportCommand(commandArgs);
      break;
    case 'diagnose-geometry':
      await (await import('./commands/diagnose-geometry.js')).diagnoseGeometryCommand(commandArgs);
      break;
    case 'ids':
      await (await import('./commands/ids.js')).idsCommand(commandArgs);
      break;
    case 'bcf':
      await (await import('./commands/bcf.js')).bcfCommand(commandArgs);
      break;
    case 'clash':
      await (await import('./commands/clash.js')).clashCommand(commandArgs);
      break;
    case 'create':
      await (await import('./commands/create.js')).createCommand(commandArgs);
      break;
    case 'eval':
      await (await import('./commands/eval.js')).evalCommand(commandArgs);
      break;
    case 'run':
      await (await import('./commands/run.js')).runCommand(commandArgs);
      break;
    case 'schema':
      await (await import('./commands/schema.js')).schemaCommand(commandArgs);
      break;
    case 'merge':
      await (await import('./commands/merge.js')).mergeCommand(commandArgs);
      break;
    case 'convert':
      await (await import('./commands/convert.js')).convertCommand(commandArgs);
      break;
    case 'diff':
      await (await import('./commands/diff.js')).diffCommand(commandArgs);
      break;
    case 'validate':
      await (await import('./commands/validate.js')).validateCommand(commandArgs);
      break;
    case 'bsdd':
      await (await import('./commands/bsdd.js')).bsddCommand(commandArgs);
      break;
    case 'stats':
      await (await import('./commands/stats.js')).statsCommand(commandArgs);
      break;
    case 'workbench-graph':
      await (await import('./commands/workbench-graph.js')).workbenchGraphCommand(commandArgs);
      break;
    case 'mutate':
      await (await import('./commands/mutate.js')).mutateCommand(commandArgs);
      break;
    case 'generate-spaces':
      await (await import('./commands/generate-spaces.js')).generateSpacesCommand(commandArgs);
      break;
    case 'ask':
      await (await import('./commands/ask.js')).askCommand(commandArgs);
      break;
    case 'view':
      await (await import('./commands/view.js')).viewCommand(commandArgs);
      break;
    case 'analyze':
      await (await import('./commands/analyze.js')).analyzeCommand(commandArgs);
      break;
    case 'lod':
      await (await import('./commands/lod.js')).lodCommand(commandArgs);
      break;
    case 'mcp':
      await (await import('./commands/mcp.js')).mcpCommand(commandArgs);
      break;
    case 'ext':
      await (await import('./commands/ext.js')).extCommand(commandArgs);
      break;
    default:
      process.stderr.write(`Unknown command: ${command}\n`);
      process.stderr.write(`Run 'ifc-lite --help' for usage.\n`);
      process.exit(1);
  }
}

main().catch((err: Error) => {
  const label = activeCommand ? `Error [${activeCommand}]` : 'Error';
  process.stderr.write(`${label}: ${err.message}\n`);
  // Stack traces with --debug/--verbose/--log-level debug, or the legacy
  // DEBUG env var (kept for back-compat).
  if (debugFlag || logger.level() === 'debug' || process.env.DEBUG) {
    process.stderr.write((err.stack ?? '') + '\n');
  } else {
    process.stderr.write(
      `Hint: re-run with --debug for a stack trace, or \`ifc-lite ${activeCommand || '<command>'} --help\` for usage.\n`,
    );
  }
  process.exit(1);
});
