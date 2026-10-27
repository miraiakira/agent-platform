import type {
  GenerateOptions,
  GenerateResult,
  ModelProvider,
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
}