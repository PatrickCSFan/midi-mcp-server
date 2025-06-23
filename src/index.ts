#!/usr/bin/env node
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ErrorCode,
  ListToolsRequestSchema,
  McpError,
} from "@modelcontextprotocol/sdk/types.js";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";
import MidiWriter from 'midi-writer-js';

interface MidiNote {
  pitch: number | string;
  beat?: number; // Position in beats (1.0 = first beat, 1.5 = between first and second beat)
  startTime?: number;
  time?: number;
  duration: string; // Changed to string type
  velocity?: number;
  channel?: number;
}

interface MidiTrack {
  name?: string;
  instrument?: number;
  notes: MidiNote[];
}

interface TimeSignature {
  numerator: number;
  denominator: number;
}

interface MidiComposition {
  bpm: number;
  tempo?: number;
  timeSignature?: TimeSignature;
  tracks: MidiTrack[];
}

class MidiMcpServer {
  private server: Server;

  constructor() {
    this.server = new Server(
        {
          name: "midi-mcp-server",
          version: "0.1.0",
        },
        {
          capabilities: {
            tools: {},
            // Explicitly indicate that batch processing is supported
            batching: {
              supported: true
            }
          },
        }
    );

    this.setupToolHandlers();

    this.server.onerror = (error) => console.error("[MCP Error]", error);
    process.on("SIGINT", async () => {
      await this.server.close();
      process.exit(0);
    });
  }

  private setupToolHandlers() {
    this.server.setRequestHandler(ListToolsRequestSchema, async () => ({
      tools: [
        {
          name: "create_midi",
          description: "テキスト形式の音楽データからMIDIファイルを生成します。compositionが長くなる場合はinputSchemaを一度JSONファイルに書き出して読み込んで渡すようにすると安定します。",
          inputSchema: {
            type: "object",
            properties: {
              title: {
                type: "string",
                description: "曲のタイトル",
              },
              composition: {
                type: "object",
                description: "音楽データのオブジェクト",
                properties: {
                  bpm: { type: "number" },
                  timeSignature: {
                    type: "object",
                    properties: {
                      numerator: { type: "number" },
                      denominator: { type: "number" }
                    }
                  },
                  tracks: {
                    type: "array",
                    items: {
                      type: "object",
                      properties: {
                        name: { type: "string" },
                        instrument: { type: "number" },
                        notes: {
                          type: "array",
                          items: {
                            type: "object",
                            properties: {
                              pitch: { type: "number" },
                              beat: {
                                type: "number",
                                description: "拍単位での位置（1.0 = 1拍目、1.5 = 1拍目と2拍目の間）"
                              },
                              startTime: { type: "number" },
                              duration: {
                                type: "string",
                                enum: ["1", "2", "4", "8", "16", "32", "64"],
                                description: "音符の長さ（'1'=全音符, '2'=2分音符, '4'=4分音符, '8'=8分音符, '16'=16分音符, '32'=32分音符, '64'=64分音符）"
                              },
                              velocity: { type: "number" }
                            }
                          }
                        }
                      }
                    }
                  }
                },
                required: ["bpm", "tracks"]
              },
              composition_file: {
                type: "string",
                description: "音楽データが含まれるJSONファイルの絶対パス。compositionが大きい場合はこちらを使用してください。"
              },
              output_path: {
                type: "string",
                description: "出力ファイル絶対パス",
              },
            },
            required: ["title", "output_path"],
            oneOf: [
              { required: ["composition"] },
              { required: ["composition_file"] }
            ]
          },
        },
      ],
    }));

    this.server.setRequestHandler(
        CallToolRequestSchema,
        async (request) => {
          const toolName = request.params.name;

          try {
            if (toolName !== "create_midi") {
              throw new McpError(
                  ErrorCode.MethodNotFound,
                  `Unknown tool: ${toolName}`
              );
            }

            const args = request.params.arguments as {
              title: string;
              composition?: MidiComposition | string;
              composition_file?: string;
              output_path: string;
            };

            // Send progress notification
            this.server.notification({
              method: "notifications/progress",
              params: {
                progress: 0,
                message: "MIDI生成を開始しました"
              }
            });

            let composition: MidiComposition;

            // Error if neither composition nor composition_file is specified
            if (!args.composition && !args.composition_file) {
              throw new McpError(
                  ErrorCode.InvalidParams,
                  "composition または composition_file のいずれかを指定する必要があります"
              );
            }

            try {
              // If composition_file is specified, load it from the file
              if (args.composition_file) {
                try {
                  const fileContent = fs.readFileSync(args.composition_file, 'utf8');
                  composition = JSON.parse(fileContent);
                } catch (e) {
                  throw new McpError(
                      ErrorCode.InvalidParams,
                      `JSONファイルの読み込みに失敗しました: ${(e as Error).message}`
                  );
                }
              } else if (typeof args.composition === "string") {
                composition = JSON.parse(args.composition);
              } else {
                composition = args.composition as MidiComposition;
              }

              // Convert numeric durations to strings
              composition.tracks.forEach(track => {
                track.notes.forEach(note => {
                  if (typeof note.duration === 'number') {
                    // Convert numeric durations to the appropriate string
                    switch (note.duration) {
                      case 0.0625: note.duration = '64'; break; // 64th note
                      case 0.125: note.duration = '32'; break;
                      case 0.25: note.duration = '16'; break;
                      case 0.5: note.duration = '8'; break;
                      case 1: note.duration = '4'; break;
                      case 2: note.duration = '2'; break;
                      default: note.duration = '4'; // Default value
                    }
                  }
                });
              });

              // Convert the time property to startTime
              composition.tracks.forEach(track => {
                track.notes.forEach(note => {
                  if ('time' in note && note.startTime === undefined) {
                    note.startTime = note.time;
                    delete note.time;
                  }
                });
              });

            } catch (e) {
              throw new McpError(
                  ErrorCode.InvalidParams,
                  `Invalid composition format: ${(e as Error).message}`
              );
            }

            const midiFilePath = await this.createMidiFile(
                args.title,
                composition,
                args.output_path
            );

            // Completion notification
            this.server.notification({
              method: "notifications/progress",
              params: {
                progress: 100,
                message: "MIDI生成が完了しました"
              }
            });

            return {
              content: [
                {
                  type: "text",
                  text: `「${args.title}」のMIDIファイルを生成しました。ファイルは ${midiFilePath} に保存されました。`,
                },
              ],
            };
          } catch (error) {
            return {
              content: [
                {
                  type: "text",
                  text: `エラーが発生しました: ${(error as Error).message}`,
                },
              ],
              isError: true,
            };
          }
        }
    );
  }

  private noteToMidiNumber(note: string | number): string | number {
    if (typeof note === "number") {
      return note;
    }
    return note;
  }

  private convertBeatToWait(beat: number, bpm: number): string {
    // Convert to MIDI writer wait format
    const PPQ = 128;

    // Beats start at 1, so subtract 1 to get the actual position
    // Example: beat 1.0 is actually the 0th beat (start of the piece)
    const adjustedBeat = beat - 1;

    // Convert beats to ticks
    const ticks = Math.round((adjustedBeat * PPQ) / bpm);

    return `T${ticks}`;
  }

  private async processMidiComposition(composition: MidiComposition): Promise<void> {
    // When processing a large composition, split it by track
    const batchSize = 50; // Number of notes to process at once
    const promises: Promise<any>[] = [];

    // Variables for progress notifications
    const totalTracks = composition.tracks.length;
    let processedTracks = 0;

    for (const track of composition.tracks) {
      // Split track notes into manageable chunks
      if (track.notes.length > batchSize) {
        const chunks = this.chunkArray(track.notes, batchSize);
        const chunkPromises = chunks.map(chunk => this.processNoteChunk(chunk));
        await Promise.all(chunkPromises);
      } else {
        await this.processTrack(track);
      }

      processedTracks++;
        // Update progress
      const progress = Math.floor((processedTracks / totalTracks) * 100);
      this.server.notification({
        method: "notifications/progress",
        params: {
          progress: progress,
          message: `トラック ${processedTracks}/${totalTracks} を処理中...`
        }
      });
    }
  }

  private chunkArray<T>(array: T[], size: number): T[][] {
    const chunks: T[][] = [];
    for (let i = 0; i < array.length; i += size) {
      chunks.push(array.slice(i, i + size));
    }
    return chunks;
  }

  private async processNoteChunk(notes: MidiNote[]): Promise<void> {
    // Logic to process a chunk of notes
    return new Promise((resolve) => {
        // Handle each note (actual processing occurs when generating the MIDI file)
      resolve();
    });
  }

  private async processTrack(track: MidiTrack): Promise<void> {
    // Logic to process an entire track
    return new Promise((resolve) => {
        // Handle the track (actual processing occurs when generating the MIDI file)
      resolve();
    });
  }

  private async createMidiFile(
      title: string,
      composition: MidiComposition,
      outputPath: string
  ): Promise<string> {
    try {
      // Preprocess large compositions
      await this.processMidiComposition(composition);

      // Generate the MIDI file using MidiWriterJS
      const tracks: any[] = [];

      // Process each track
      composition.tracks.forEach((trackData, trackIndex) => {
        // The midi-writer-js type definitions seem incorrect.
        // @ts-ignore
        const track = new MidiWriter.Track();

        // Set the track name
        if (trackData.name) {
          track.addTrackName(trackData.name);
        }

        // Set the tempo
        const tempo = composition.bpm || composition.tempo || 120;
        track.setTempo(tempo);

        // Set the time signature
        const timeSignature = composition.timeSignature || { numerator: 4, denominator: 4 };
        track.setTimeSignature(timeSignature.numerator, timeSignature.denominator);

        // Set the instrument
        if (trackData.instrument !== undefined) {
          // The midi-writer-js type definitions seem incorrect.
          // @ts-ignore
          track.addEvent(new MidiWriter.ProgramChangeEvent({
            instrument: trackData.instrument,
            channel: trackIndex % 16
          }));
        }

        // Add notes
        trackData.notes.forEach(note => {
          const pitch = this.noteToMidiNumber(note.pitch);
          const velocity = note.velocity !== undefined ? note.velocity : 100;
          const channel = note.channel !== undefined ? note.channel % 16 : trackIndex % 16;

          // Use beat if provided, otherwise use startTime or time
          let wait;
          if (note.beat !== undefined) {
            wait = this.convertBeatToWait(note.beat, composition.bpm);
          } else {
            const startTime = note.startTime || 0;
            wait = `T${Math.round(startTime * 0.5)}`;
          }

        // The midi-writer-js type definitions seem incorrect.
          // @ts-ignore
          track.addEvent(new MidiWriter.NoteEvent({
            pitch: [pitch],
            duration: note.duration,
            velocity: velocity,
            channel: channel,
            wait: wait
          }));
        });

        tracks.push(track);
      });

      // The midi-writer-js type definitions seem incorrect.
      // @ts-ignore
      const writer = new MidiWriter.Writer(tracks);

      // Handle the output path
      let outputFilePath;
      if (path.isAbsolute(outputPath)) {
        outputFilePath = outputPath;
      } else {
        const safeBaseDir = process.env.HOME || process.env.USERPROFILE || os.tmpdir();
        const midiDir = path.join(safeBaseDir, 'midi-files');
        if (!fs.existsSync(midiDir)) {
          fs.mkdirSync(midiDir, { recursive: true });
        }
        const fileName = path.basename(outputPath);
        outputFilePath = path.join(midiDir, fileName);
      }

      fs.writeFileSync(outputFilePath, Buffer.from(writer.buildFile(), 'base64'), 'binary');

      return outputFilePath;
    } catch (error) {
      console.error("MIDI生成中にエラーが発生しました:", error);
      throw new McpError(
          ErrorCode.InternalError,
          `MIDI生成中にエラーが発生しました: ${(error as Error).message}`
      );
    }
  }

  async run() {
    const transport = new StdioServerTransport();
    await this.server.connect(transport);
    console.error("MIDI MCP server running on stdio");
  }
}

const server = new MidiMcpServer();

async function main() {
  await server.run();
}

main().catch((error) => {
  console.error("Fatal error in main():", error);
  process.exit(1);
});
