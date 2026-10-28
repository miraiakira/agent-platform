import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
  StreamEvent,
} from "./types";

export class AIService {
  constructor(
    private readonly provider: ModelProvider,
  ) {}

  generate(
    options: GenerateOptions,
  ): Promise<GenerateResult> {
    return this.provider.generate(options);
  }

  stream(
    options: GenerateOptions,
  ): AsyncIterable<StreamEvent> {
    return this.provider.stream(options);
  }
}