import { ContainedSandbox } from "contained-sandbox";
import { CatMCPClient, type TaskProgress } from "../tools/cat-client.js";

export interface CoderInput {
    testPlan: string;
    repoUrl: string;
    token: string;
    branch: string;
    containedBinaryPath?: string;
    rootfsPath?: string;
    onProgress?: (progress: TaskProgress) => void;
}

export interface CoderOutput {
    summary: string;
    testsGenerated: string[];
    testsPassed: boolean;
}

export async function runCoderAgent(input: CoderInput): Promise<CoderOutput> {
    const sandbox = new ContainedSandbox({
        ...(input.containedBinaryPath ? { binaryPath: input.containedBinaryPath } : {}),
        ...(input.rootfsPath ? { rootfsPath: input.rootfsPath } : {}),
        workdir: "/workspace",
    });

    const cat = new CatMCPClient();

    try {
        await sandbox.init(input.repoUrl, input.token, input.branch);
        await cat.connectToContained(sandbox);

        const progress = await cat.runTaskAndWait(
            buildCoderPrompt(input.testPlan),
            "/workspace",
            {
                pollInterval: 2000,
                timeout: 15 * 60 * 1000,
                onProgress: input.onProgress,
            }
        );

        return extractCoderOutput(progress);
    } finally {
        await cat.close();
        await sandbox.destroy();
    }
}

function buildCoderPrompt(testPlan: string): string {
    return `You are a coding agent. Your job is to write integration tests based on the test plan below, run them, and iterate until they pass.

Test Plan:
${testPlan}

Requirements:
- Inspect the existing code structure first before writing tests
- Write tests in the same framework already used in the project (check package.json)
- Run the tests after writing them
- If tests fail, fix them and run again
- Report the final test files created and whether tests passed`;
}

function extractCoderOutput(progress: TaskProgress): CoderOutput {
    const result = progress.result ?? "";

    const fileMatches = result.match(/[\w/.-]+\.(test|spec)\.(ts|js|tsx|jsx)/g) ?? [];
    const testsGenerated = [...new Set(fileMatches)];

    const testsPassed =
        progress.status === "completed" &&
        !result.toLowerCase().includes("failed") &&
        !result.toLowerCase().includes("failing");

    return {
        summary: result || `Tests ${testsPassed ? "generated and passing" : "generated with issues"}.`,
        testsGenerated,
        testsPassed,
    };
}
