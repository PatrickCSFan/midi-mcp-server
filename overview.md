# MIDI MCP Server

## Overview

MIDI MCP Server is a lightweight Model Context Protocol (MCP) service that converts structured music data into MIDI files.  It is implemented in TypeScript and communicates with MCP clients over standard input/output.

## Installation

```bash
npm install
npm run build
```

## Usage

After building the project, register the server with your MCP client configuration.  A typical configuration entry looks like:

```json
"mcpServers": {
  "musicComposer": {
    "command": "node",
    "args": ["/path/to/midi-mcp-server/build/index.js"]
  }
}
```

Replace `/path/to/` with the path to this repository.

### create_midi Tool

The server exposes a single tool, `create_midi`, which accepts a composition definition and produces a MIDI file.

**Required parameters**:
- `title` – title of the piece
- `output_path` – file path where the MIDI file should be written

Either `composition` (inline JSON) or `composition_file` (path to JSON) must also be supplied.  The format of `composition` is:

```json
{
  "bpm": 120,
  "timeSignature": { "numerator": 4, "denominator": 4 },
  "tracks": [
    {
      "name": "Piano",
      "instrument": 0,
      "notes": [
        { "pitch": 60, "startTime": 0, "duration": "4", "velocity": 100 }
      ]
    }
  ]
}
```

## Key Dependencies

- `@modelcontextprotocol/sdk` – core MCP server framework
- `midi-writer-js` – library used to construct MIDI files
- `midi-parser-js` – included for MIDI parsing capabilities
- Development: `typescript`, `@types/node`, `@types/jsmidgen`

## TODO

- [ ] Replace placeholder checks in `.git/hooks/sendemail-validate.sample`
  - [ ] Add cover letter validation logic
  - [ ] Add per-patch validation logic
  - [ ] Add series-level validation logic
