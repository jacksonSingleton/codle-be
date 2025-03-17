const express = require("express");
const cors = require("cors");
const axios = require("axios");
const fs = require("fs").promises;
const path = require("path");
const app = express();

app.use(express.json());
app.use(cors());

// Problems directory
const PROBLEMS_DIR = path.join(__dirname, "problems");

// Cache for today's problem
let dailyProblemCache = null;
let lastCacheUpdate = null;

// Get the daily problem (most recent one)
async function getDailyProblem() {
  const now = new Date();
  
  // Only reload if cache is null or older than 1 hour
  if (dailyProblemCache && lastCacheUpdate && (now - lastCacheUpdate) < 3600000) {
    return dailyProblemCache;
  }

  try {
    const files = await fs.readdir(PROBLEMS_DIR);
    const problems = [];

    for (const file of files) {
      if (file.endsWith(".json")) {
        const filePath = path.join(PROBLEMS_DIR, file);
        const content = await fs.readFile(filePath, "utf8");
        problems.push(JSON.parse(content));
      }
    }

    // Sort problems by date
    problems.sort((a, b) => new Date(b.datePublished) - new Date(a.datePublished));
    
    // No problems found
    if (problems.length === 0) {
      return null;
    }
    
    // Set the most recent problem as today's problem
    dailyProblemCache = problems[0];
    lastCacheUpdate = now;
    return dailyProblemCache;
  } catch (error) {
    console.error("Error loading daily problem:", error);
    return null;
  }
}

// Endpoint to get today's problem (without solution)
app.get("/api/problem", async (req, res) => {
  try {
    const problem = await getDailyProblem();
    if (!problem) {
      return res.status(404).json({ error: "No daily problem found" });
    }
    
    // Remove solution from the response
    const { solution, ...sanitizedProblem } = problem;
    res.json(sanitizedProblem);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to run code against today's problem test cases
app.post("/api/run", async (req, res) => {
  const { userCode, language = "python" } = req.body;
  
  try {
    // Load today's problem to get test cases
    const problem = await getDailyProblem();
    
    if (!problem) {
      return res.status(404).json({ error: "No daily problem found" });
    }
    
    // Create test wrapper based on the problem
    let testWrapper;
    
    if (language === "python") {
      testWrapper = createPythonTestWrapper(userCode, problem);
    } else {
      return res.status(400).json({ error: `Language ${language} is not supported yet` });
    }
    
    const pistonRequest = {
      language: "python",
      version: "3.10.0",
      files: [
        {
          name: "main.py",
          content: testWrapper,
        },
      ],
    };
    
    const { data } = await axios.post(
      "https://emkc.org/api/v2/piston/execute",
      pistonRequest
    );
    
    // Process the response
    const result = processPistonResponse(data, problem);
    res.json(result);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});


// Create a Python test wrapper
function createPythonTestWrapper(userCode, problem) {
  // Extract function name from the problem
  const functionName = extractFunctionName(problem.startingCode.python);
  
  return `
import json
import traceback

# Global namespace for user code
global_namespace = {}

# Execute user code
try:
    exec("""
${userCode}
""", global_namespace)
except Exception as e:
    print(json.dumps({
        "status": "error",
        "message": f"Error in user code: {str(e)}",
        "traceback": traceback.format_exc()
    }))
    exit(1)

# Run test cases
def run_tests():
    # Convert test cases to Python format
    test_cases = ${JSON.stringify(problem.testCases)}
    results = []
    
    # Check if required function exists
    if "${functionName}" not in global_namespace:
        print(json.dumps({
            "status": "error",
            "message": f"Function '${functionName}' not found in your code."
        }))
        exit(1)
    
    # Run each test case
    for i, test in enumerate(test_cases):
        try:
            # Extract inputs
            input_params = test["input"]
            
            # Call the function with the right parameters
            if isinstance(input_params, dict):
                # If input is a dictionary, extract parameters
                function_args = list(input_params.values())
                output = global_namespace["${functionName}"](*function_args)
            else:
                # If input is a single value
                output = global_namespace["${functionName}"](input_params)
            
            # Check if result matches expected
            passed = output == test["expected"]
            
            results.append({
                "testCase": i + 1,
                "description": test.get("description", f"Test case {i+1}"),
                "input": input_params,
                "expected": test["expected"],
                "actual": output,
                "passed": passed
            })
        except Exception as e:
            results.append({
                "testCase": i + 1,
                "description": test.get("description", f"Test case {i+1}"),
                "input": test["input"],
                "expected": test["expected"],
                "error": str(e),
                "traceback": traceback.format_exc(),
                "passed": False
            })
    
    # Print results as JSON
    print(json.dumps({
        "status": "completed",
        "results": results,
        "summary": {
            "total": len(results),
            "passed": sum(1 for r in results if r["passed"]),
            "failed": sum(1 for r in results if not r["passed"])
        }
    }))

# Run tests
run_tests()
`;
}

// Extract function name from Python code
function extractFunctionName(code) {
  const match = code.match(/def\s+([a-zA-Z0-9_]+)\s*\(/);
  return match ? match[1] : "user_function";
}

// Process Piston API response
function processPistonResponse(pistonResponse, problem) {
  // Check if execution was successful
  if (pistonResponse.run.code !== 0) {
    return {
      status: "error",
      message: "Execution error",
      details: pistonResponse.run.stderr || pistonResponse.run.output
    };
  }

  try {
    // Try to parse the JSON output from the test runner
    const testResults = JSON.parse(pistonResponse.run.stdout);
    
    // Check if all tests passed to determine if all issues are fixed
    const allPassed = testResults.status === "completed" && 
                     testResults.summary.failed === 0;
    
    // Add information about which issues might be fixed based on passing tests
    if (testResults.status === "completed") {
      // Only try to analyze issues if the problem has an issues field
      if (problem.issues && Array.isArray(problem.issues)) {
        testResults.issuesFixed = analyzeIssuesFixed(testResults.results, problem.issues);
      } else {
        testResults.issuesFixed = {};
      }
      testResults.allIssuesFixed = allPassed;
    }
    
    return testResults;
  } catch (error) {
    console.error("Error parsing test results:", error, "Output:", pistonResponse.run.stdout);
    // If unable to parse JSON, return raw output
    return {
      status: "error",
      message: "Failed to parse test results",
      details: pistonResponse.run.stdout
    };
  }
}

// Analyze which issues might be fixed based on test results
function analyzeIssuesFixed(results, issues) {
  // This is a simplified implementation
  // A more sophisticated implementation would map specific test cases to specific issues
  
  const issuesFixed = {};
  
  // Initialize all issues as not fixed
  issues.forEach(issue => {
    issuesFixed[issue.id] = false;
  });
  
  // If all tests pass, consider all issues fixed
  const allPassed = results.every(r => r.passed);
  if (allPassed) {
    issues.forEach(issue => {
      issuesFixed[issue.id] = true;
    });
    return issuesFixed;
  }
  
  // Example of matching specific test cases to issues
  // You would customize this based on your problem structure
  results.forEach(result => {
    if (result.passed) {
      // Example: If test case for ordering passes, mark that issue as fixed
      if (result.description.includes("ascending order") && issues.some(i => i.id === 1)) {
        issuesFixed[1] = true;
      }
      
      // Example: If duplicate numbers test passes, mark that issue as fixed
      if (result.description.includes("Duplicate") && issues.some(i => i.id === 2)) {
        issuesFixed[2] = true;
      }
      
      // Example: If negative numbers test passes, mark that issue as fixed
      if (result.description.includes("Negative") && issues.some(i => i.id === 3)) {
        issuesFixed[3] = true;
      }
    }
  });
  
  return issuesFixed;
}

const PORT = process.env.PORT || 3001;
app.listen(PORT, "0.0.0.0", () =>
    console.log(`Server running on port ${PORT}`)
);
