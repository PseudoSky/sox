// Skill: Hello World
// A minimal hello-world skill demonstrating the extension scaffold

export interface SkillInput {
  /** Input to process */
  input: string;
}

export interface SkillOutput {
  result: string;
}

export async function run(input: SkillInput): Promise<SkillOutput> {
  // TODO: implement skill logic
  return { result: `Processed: ${input.input}` };
}