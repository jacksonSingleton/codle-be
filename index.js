const express = require("express");
const cors = require("cors");
const axios = require("axios");

const app = express();
app.use(express.json());
app.use(cors());

app.post("/run", async (req, res) => {
  const { language, userCode } = req.body;

  const testWrapper = `
def run_tests():
    test_cases = [{"input": [2, 3], "expected": 5}]
    from user_code import user_function
    results = [{"input": t["input"], "output": user_function(*t["input"]), "expected": t["expected"], "passed": user_function(*t["input"]) == t["expected"]} for t in test_cases]
    print(results)
`;

  const pistonRequest = {
    language: language || "python",
    version: "3.10.0",
    files: [
      { name: "user_code.py", content: userCode },
      { name: "test_runner.py", content: testWrapper }
    ]
  };

  try {
    const { data } = await axios.post("https://emkc.org/api/v2/piston/execute", pistonRequest);
    res.json(data);
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const PORT = process.env.port || 3001;
app.listen(PORT, "0.0.0.0", () => console.log(`Server running on port ${PORT}`));

