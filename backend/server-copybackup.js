// --- Imports ---
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import multer from "multer";
import fs from "fs";
import path from "path";
import OpenAI from "openai";
import { Low } from "lowdb";
import { fileURLToPath } from "url";
import { JSONFile } from "lowdb/node";
import { handleChat } from "./chatbot.js";
import { exec } from "child_process";
import session from "express-session";
import bcrypt from "bcryptjs";

dotenv.config();

// --- File Paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// --- Ensure directories exist ---
const dbDir = path.join(__dirname, "db");
const uploadsDir = path.join(__dirname, "uploads");
const assessmentsDir = path.join(uploadsDir, "assessments");
const coursesDir = path.join(uploadsDir, "courses");
const lessonsDir = path.join(uploadsDir, "lessons");

const app = express();``
const PORT = process.env.PORT || 3000;

// Initialize OpenAI client
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

// --- Middleware ---
app.use(cors());
app.use(express.json());
app.use("/uploads", express.static("uploads"));
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "frontend")));


// Ensure all folders exist
[dbDir, uploadsDir, lessonsDir, coursesDir, assessmentsDir].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir);
});

// --- Serve uploads statically ---
app.use("/uploads", express.static(uploadsDir));

// --- Multer File Upload Setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    if (req.path.includes("/assessments")) cb(null, assessmentsDir);
    else if (req.path.includes("/courses")) cb(null, coursesDir);
    else if (req.path.includes("/lessons")) cb(null, lessonsDir);
    else cb(null, uploadsDir);
  },
  filename: (_, file, cb) => cb(null, `${Date.now()}-${file.originalname}`)
});
const upload = multer({ storage });

// --- LowDB Setup ---
const adapter = new JSONFile(path.join(dbDir, "database.json"));
const defaultData = { lessons: [], assessments: [], submissions: [], users: [], courses: [] };
const db = new Low(adapter, defaultData);

await db.read();
db.data ||= defaultData;
await db.write();

// Ensure required arrays exist
db.data ||= {};
db.data.lessons ||= [];
db.data.assessments ||= [];
db.data.submissions ||= [];
db.data.users ||= [];
db.data.courses ||= [];
await db.write();

// --- Generic CRUD Route Creator ---
const createCrudRoutes = (name) => {
  // READ all
  app.get(`/api/${name}`, async (_, res) => {
    await db.read();
    res.json(db.data[name] || []);
  });

  // CREATE
  app.post(`/api/${name}`, async (req, res) => {
    const item = { id: Date.now(), ...req.body };
    await db.read();
    db.data[name].push(item);
    await db.write();
    res.json(item);
  });

  // UPDATE
  app.put(`/api/${name}/:id`, async (req, res) => {
    await db.read();
    const index = db.data[name].findIndex(i => i.id == req.params.id);
    if (index === -1) return res.status(404).json({ message: `${name} not found` });
    db.data[name][index] = { ...db.data[name][index], ...req.body };
    await db.write();
    res.json(db.data[name][index]);
  });

  // DELETE
  app.delete(`/api/${name}/:id`, async (req, res) => {
    await db.read();
    db.data[name] = db.data[name].filter(item => item.id != req.params.id);
    await db.write();
    res.json({ message: `${name} deleted successfully` });
  });
};

// GET Routes //////////////////////////////////////////////////////////////////////////////
// Generic GET endpoint for AALL collections
app.get('/api/:collection', async (req, res) => {
  const { collection } = req.params;
  const data = db.data[collection];
  res.json(data || []);
});

// COURSES
app.get("/api/courses", async (_, res) => {
  await db.read();

  // ensure keys exist
  db.data.courses ||= [];
  db.data.lessons ||= [];
  db.data.assessments ||= [];

  const coursesWithDetails = db.data.courses.map(course => ({
    ...course,
    lessons: db.data.lessons
      .filter(l => String(l.courseId) === String(course.id))
      .map(l => l.title),
    assessments: db.data.assessments
      .filter(a => String(a.courseId) === String(course.id))
      .map(a => a.title),
  }));

  res.json(coursesWithDetails);
});

// COURSES ID
app.get("/api/courses/:id", async (req, res) => {
  await db.read();
  const { id } = req.params;
  const course = db.data.courses.find(c => String(c.id) === id);

  if (!course) return res.status(404).json({ error: "Course not found" });

  const lessons = db.data.lessons.filter(l => String(l.courseId) === id);
  const assessments = db.data.assessments.filter(a => String(a.courseId) === id);

  res.json({ ...course, lessons, assessments });
});
// LESSONS
app.get("/api/lessons", async (req, res) => {
  await db.read();
  const { courseId } = req.query;
  let lessons = db.data.lessons || [];

  if (courseId) {
    lessons = lessons.filter(l => String(l.courseId) === String(courseId));
  }

  res.json(lessons);
});

// USER ID
app.get("/api/users/:id", async (req, res) => {
  try {
    await db.read();
    const userId = req.params.id;
    const user = db.data.users.find(u => u.userId === userId && !u.dateArchived);

    if (!user) {
      return res.status(404).json({ message: "Active user not found" });
    }

    res.json(user);
  } catch (err) {
    console.error("❌ Error fetching user:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
// GET ARCHIVED USERS
app.get("/api/archived-users", async (req, res) => {
  try {
    await db.read();
    const archivedUsers = db.data.users.filter(u => u.dateArchived);
    res.json(archivedUsers);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



// ASSIGNED TRAINEES
app.get("/api/assigned", async (req, res) => {
  await db.read();
  res.json(db.data.assigned || []);
});

// POST Routes //////////////////////////////////////////////////////////////////////////////
// COURSES
app.post("/api/courses", upload.single("courseImage"), async (req, res) => {
  const { courseTitle, courseDesc } = req.body;

  if (!courseTitle || !courseDesc) {
    return res.status(400).json({ message: "Course title and description required." });
  }

  const imagePath = req.file ? `/uploads/courses/${req.file.filename}` : null;

  const newCourse = {
    id: Date.now(),
    title: courseTitle,
    description: courseDesc,
    image: imagePath,
    createdAt: new Date().toISOString(),
  };

  await db.read();
  db.data.courses.push(newCourse);
  await db.write();

  console.log("✅ New course added:", newCourse);
  res.json({ message: "Course created successfully", course: newCourse });
});

// LESSONS
app.post("/api/lessons", upload.single("lessonUpload"), async (req, res) => {
  const { lessonTitle, lessonCourse, lessonDesc } = req.body;

  if (!req.file) return res.status(400).json({ message: "No file uploaded" });

  const courseId = parseInt(lessonCourse);
  if (isNaN(courseId)) return res.status(400).json({ message: "Invalid or missing course ID" });

  const newLesson = {
    id: Date.now(),
    title: lessonTitle || "Untitled Lesson",
    description: lessonDesc || "",
    courseId,
    file: `/uploads/lessons/${req.file.filename}`,
    uploadedAt: new Date().toISOString(),
    handouts: [],
    videos: [],
    powerpoints: [],
    assessments: []
  };

  await db.read();
  db.data.lessons.push(newLesson);
  await db.write();

  console.log("✅ New lesson added:", newLesson);
  res.json({ message: "Lesson added successfully", lesson: newLesson });
});

// UPLOAD CONTENT
app.post("/api/upload-content", upload.single("contentFile"), (req, res) => {
  try {
    if (!req.file) return res.status(400).json({ message: "No file uploaded" });

    const fileData = {
      fileName: req.file.filename,
      originalName: req.file.originalname,
      type: req.body.type,
      courseId: req.body.courseId,
      lessonId: req.body.lessonId,
      description: req.body.description,
      path: `/uploads/${req.file.filename}`,
    };

    console.log("Uploaded content:", fileData);
    res.json(fileData);
  } catch (err) {
    console.error("Upload error:", err);
    res.status(500).json({ message: "Server error during upload" });
  }
});
// ASSSSSESSMENTS
app.post("/api/assessments", async (req, res) => {
  try {
    await db.read();
    db.data.assessments ||= [];

    const { title, difficulty, courseId, lessonId, duration, deadline } = req.body;

    const newAssessment = {
      id: Date.now(),
      title: title || "Untitled Assessment",
      difficulty: difficulty || "Unspecified",
      courseId: Number(courseId) || null,
      lessonId: Number(lessonId) || null,
      duration: duration || null,
      deadline: deadline || null,
      questions: [],
      createdAt: new Date().toISOString(),
    };

    db.data.assessments.push(newAssessment);
    await db.write();

// --- Save full assessment as JSON file named after title ---
const safeTitle = (newAssessment.title || `assessment-${newAssessment.id}`)
  .replace(/[^\w\s-]/gi, "_") // safer title
  .replace(/\s+/g, " ")        // normalize spaces
  .trim();

const filename = `${safeTitle}.json`;
const assessmentFilePath = path.join(assessmentsDir, filename);

// Write complete assessment object (with all questions)
fs.writeFileSync(assessmentFilePath, JSON.stringify({
  assessments: [newAssessment]  // structure matches your example
}, null, 2));

console.log(`✅ Saved assessment to: ${assessmentFilePath}`);


// Build a URL path that the frontend can use (you serve /uploads statically)
const fileUrl = `/uploads/assessments/${filename}`;

console.log(`✅ New assessment created: ${newAssessment.title}`);
console.log(`✅ Saved initial assessment file: ${assessmentFilePath}`);

// Return the assessment object and file (matches what your frontend expects)
res.json({ success: true, assessment: newAssessment, file: fileUrl });
  } catch (err) {
    console.error("❌ Error creating assessment:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});
// QUESTIONS
app.post("/api/questions", upload.none(), async (req, res) => {
  try {
    const {
      assessmentId,
      assessmentTitle,
      difficulty,
      courseId,
      lessonId,
      duration,
      deadline,
      questionNumber,
      questionType,
      question,
      questionPoints,
      options,
      answer,
      answerText,
      answerCode,
    } = req.body;

    await db.read();
    db.data.assessments ||= [];

    // --- Find or create assessment ---
    let assessment = db.data.assessments.find(a => a.id == assessmentId);
    if (!assessment) {
      assessment = {
        id: Number(assessmentId),
        title: assessmentTitle || `Assessment ${assessmentId}`,
        difficulty: difficulty || "Unspecified",
        courseId: Number(courseId) || null,
        lessonId: Number(lessonId) || null,
        duration: duration || null,
        deadline: deadline || null,
        questions: [],
        createdAt: new Date().toISOString(),
      };
      db.data.assessments.push(assessment);
    } else {
      if (assessmentTitle) assessment.title = assessmentTitle;
      if (difficulty) assessment.difficulty = difficulty;
      if (courseId) assessment.courseId = Number(courseId);
      if (lessonId) assessment.lessonId = Number(lessonId);
      if (duration) assessment.duration = duration;
      if (deadline) assessment.deadline = deadline;
    }

    // --- Create new question object ---
    const newQuestion = {
      id: Date.now(),
      questionNumber: Number(questionNumber) || assessment.questions.length + 1,
      questionType,
      question,
      options: questionType === "mcq" ? JSON.parse(options || "[]") : [],
      answer: questionType === "mcq" ? answer : null,
      answerText: questionType === "textbox" ? answerText : null,
      answerCode: questionType === "code" ? answerCode : null,
      points: parseInt(questionPoints, 10) || 0
    };

    // --- Save question to assessment ---
    assessment.questions.push(newQuestion);
    await db.write();

    // --- Save assessment as JSON file ---
    const safeTitle = (assessment.title || `assessment-${assessment.id}`)
      .replace(/[^a-z0-9_\- ]/gi, "_")
      .trim();

    const assessmentFilePath = path.join(assessmentsDir, `${safeTitle}.json`);
    fs.writeFileSync(assessmentFilePath, JSON.stringify(assessment, null, 2));

    console.log(`✅ Added question #${newQuestion.questionNumber} to assessment "${assessment.title}"`);
    console.log(`✅ Saved to: ${assessmentFilePath}`);

    res.json({
      success: true,
      message: `Question ${newQuestion.questionNumber} added successfully`,
      question: newQuestion,
      assessment
    });

  } catch (err) {
    console.error("❌ Error saving question:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// COMPIIILEERR
app.post("/api/compile", async (req, res) => {
  const { language, code } = req.body;

  if (!language || !code) {
    return res.status(400).json({ error: "Language and code are required." });
  }

  try {
    // Save code temporarily
    const tempDir = path.join(__dirname, "temp_code");
    if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir);

    let filePath, cmd;

    switch (language) {
      case "python":
        filePath = path.join(tempDir, "main.py");
        fs.writeFileSync(filePath, code);
        cmd = `python "${filePath}"`;
        break;

      case "javascript":
        filePath = path.join(tempDir, "main.js");
        fs.writeFileSync(filePath, code);
        cmd = `node "${filePath}"`;
        break;

      case "java":
        filePath = path.join(tempDir, "Main.java");
        fs.writeFileSync(filePath, code);
        cmd = `javac "${filePath}" && java -cp "${tempDir}" Main`;
        break;

      case "cpp":
        filePath = path.join(tempDir, "main.cpp");
        fs.writeFileSync(filePath, code);
        cmd = `g++ "${filePath}" -o "${tempDir}/a.out" && "${tempDir}/a.out"`;
        break;

      default:
        return res.status(400).json({ error: "Unsupported language." });
    }

    // Execute and return result
    import("child_process").then(({ exec }) => {
      exec(cmd, (error, stdout, stderr) => {
        if (error) {
          return res.json({
            output: stderr || error.message,
            success: false,
          });
        }
        res.json({
          output: stdout || "Program finished with exit code 0",
          success: true,
        });
      });
    });

  } catch (err) {
    console.error("❌ Compilation error:", err);
    res.status(500).json({ error: "Failed to compile or execute code." });
  }
});

// AI BOTS
// QUIZ/ASSESS
app.post("/api/quizbot", async (req, res) => {
  const { message, questionType } = req.body;

  try {
    // Choose system prompt based on question type
    let systemPrompt = "";

    switch (questionType) {
      case "mcq":
        systemPrompt = `
          You are an AI that creates multiple-choice questions.
          Given a topic or concept, generate a challenging and well-structured MCQ.
          Always provide 4 options (A, B, C, D) and specify the correct answer with an explanation.
        `;
        break;

      case "essay":
        systemPrompt = `
          You are an AI that helps create essay-type questions or essay-style answers.
          Write thoughtful, open-ended questions that assess deep understanding.
          When asked to answer, write in a clear and academic tone.
        `;
        break;

      case "code":
        systemPrompt = `
          You are an expert programming tutor.
          Explain programming concepts, debug code, or create coding challenges.
          Provide example code when helpful and explain logic clearly.
        `;
        break;

      case "logic":
        systemPrompt = `
          You are an AI specialized in logical reasoning and problem-solving.
          When given a scenario or question, respond step-by-step and explain the reasoning clearly.
        `;
        break;

      default:
        systemPrompt = `
          You are a helpful AI tutor that can answer technical and academic questions.
          Respond clearly and concisely, tailoring the response to the user's topic.
        `;
    }

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        { role: "system", content: systemPrompt },
        { role: "user", content: message },
      ],
      max_tokens: 600,
    });

    const aiReply = completion.choices[0].message.content;
    res.json({ reply: aiReply });

  } catch (error) {
    console.error("Quizbot AI Error:", error);
    res.status(500).json({ reply: "Error processing quiz or question request." });
  }
});

// COMPILER BOT
app.post("/ask", async (req, res) => {
  try {
    const { prompt, output } = req.body;
    if (!prompt) return res.status(400).json({ error: "Prompt required" });

    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages: [
        {
          role: "system",
          content:
            "You are a helpful AI coding assistant. Analyze compiler output, help debug code, and guide users clearly.",
        },
        {
          role: "user",
          content: `User question: ${prompt}\n\nProgram output:\n${output || "(no output)"}\n\nRespond with helpful feedback or guidance.`,
        },
      ],
      max_tokens: 300,
    });

    res.json({ reply: completion.choices[0].message.content });
  } catch (err) {
    console.error("AI error:", err);
    res.status(500).json({ error: "Failed to get AI response." });
  }
});

/// USERS!!!
app.post("/api/users/add", async (req, res) => {
  await db.read();
  db.data.users ||= [];

  const { fullName, userType, email, password } = req.body;
  if (!fullName || !userType || !email || !password)
    return res.status(400).json({ message: "All fields are required." });

  const existingUser = db.data.users.find(u => u.email === email);
  if (existingUser)
    return res.status(400).json({ message: "Email already registered." });

  const prefix = userType === "SME" ? "S" : userType === "Admin" ? "A" : "T";
  const userId = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;

  const newUser = {
    id: Date.now(),
    userId,
    fullName,
    userType,
    email,
    password,
    createdAt: new Date().toISOString(),
  };

  db.data.users.push(newUser);
  await db.write();
  res.json({ message: "✅ User added successfully!", user: newUser });
});

// ASSIGN COURSE TO TRAINEE
app.post("/api/assigned", async (req, res) => {
  try {
    const { userId, fullName, email, courseTitle, status, progress } = req.body;

    if (!userId || !courseTitle) {
      return res.status(400).json({ message: "Missing required fields." });
    }

    await db.read();
    db.data.assigned ||= [];

    // Check if trainee already has the same course
    const alreadyAssigned = db.data.assigned.some(
      (a) => a.userId === userId && a.courseTitle === courseTitle
    );

    if (alreadyAssigned) {
      return res.status(409).json({
        message: `⚠️ ${fullName} is already assigned to ${courseTitle}.`,
      });
    }

    // Add new course for traineee
    const newAssign = {
      id: Date.now(),
      userId,
      fullName,
      userType: "Trainee",
      email,
      courseTitle,
      status: status || "Not Started",
      progress: progress || "0%",
      assignedDate: new Date().toISOString(),
    };

    db.data.assigned.push(newAssign);
    await db.write();

    res.status(201).json({
      message: "✅ Trainee assigned successfully!",
      newAssign,
    });
  } catch (err) {
    console.error("❌ Error saving assignment:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});
// PATCH Routes //////////////////////////////////////////////////////////////////////////////
app.patch("/api/users/:id/archive", async (req, res) => {
  try {
    await db.read();
    const userId = req.params.id;
    const user = db.data.users.find(u => u.userId === userId);

    if (!user)
      return res.status(404).json({ message: "User not found" });

    user.dateArchived = new Date().toISOString();
    await db.write();

    res.json({ message: "User archived successfully", user });
  } catch (err) {
    console.error("Error archiving user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PATCH Restore user
app.patch("/api/archived-users/restore/:id", async (req, res) => {
  try {
    await db.read();
    const user = db.data.users.find(u => u.userId === req.params.id && u.dateArchived);
    if (!user) return res.status(404).json({ message: "Archived user not found" });

    delete user.dateArchived;
    await db.write();
    res.json({ message: "✅ User restored successfully", user });
  } catch (err) {
    console.error("❌ Error restoring user:", err);
    res.status(500).json({ message: "Internal server error" });
  }
});

// RESTORE ALL
app.patch("/api/archived-users/restore-all", async (_, res) => {
  try {
    await db.read();
    let restored = 0;
    db.data.users.forEach(u => {
      if (u.dateArchived) {
        delete u.dateArchived;
        restored++;
      }
    });
    await db.write();
    res.json({ message: `✅ Restored ${restored} users successfully` });
  } catch (err) {
    console.error("❌ Error restoring users:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// PUT Routes //////////////////////////////////////////////////////////////////////////////
app.put("/api/assigned/:userId", async (req, res) => {
  await db.read();
  const { userId } = req.params;
  const { courseId, status, progress } = req.body;

  const trainee = db.data.assigned.find(t => t.userId === userId);
  if (!trainee) return res.status(404).json({ error: "Trainee not found" });

  // Update course info
  const course = db.data.courses.find(c => c.courseId === courseId);
  if (!course) return res.status(404).json({ error: "Course not found" });

  trainee.courseId = courseId;
  trainee.courseTitle = course.courseTitle;
  trainee.status = status;
  trainee.progress = progress;

  await db.write();
  res.json({ message: "Course reassigned successfully", trainee });
});

// DELETE Routes //////////////////////////////////////////////////////////////////////////////
app.delete("/api/courses/:id", async (req, res) => {
  const { id } = req.params;
  try {
    const course = db.data.courses.find(c => c.id == id);
    if (!course) return res.status(404).json({ message: "Course not found" });

    // --- Delete linked lessons ---
    db.data.lessons = db.data.lessons.filter(l => l.courseId != id);

    // --- Delete linked assessments ---
    db.data.assessments = db.data.assessments.filter(a => a.courseId != id);

    // --- Delete course image file if exists ---
    if (course.image) {
      const imagePath = path.join(process.cwd(), course.image);
      if (fs.existsSync(imagePath)) {
        fs.unlinkSync(imagePath);
      }
    }

    // --- Delete the course itself ---
    db.data.courses = db.data.courses.filter(c => c.id != id);
    await db.write();

    res.json({ message: "Course, lessons, assessments, and image deleted" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Failed to delete course" });
  }
});
// DEL USERS IN ADMIN
app.delete("/api/archived-users/:id", async (req, res) => {
  try {
    await db.read();
    const idx = db.data.users.findIndex(u => u.userId === req.params.id);
    if (idx === -1) return res.status(404).json({ message: "User not found" });

    db.data.users.splice(idx, 1);
    await db.write();
    res.json({ message: "User deleted permanently" });
  } catch (err) {
    console.error("Error deleting archived user:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// DELETE ALL
app.delete("/api/archived-users/delete-all", async (_, res) => {
  try {
    await db.read();
    const before = db.data.users.length;
    db.data.users = db.data.users.filter(u => !u.dateArchived);
    const deleted = before - db.data.users.length;
    await db.write();
    res.json({ message: `Deleted ${deleted} archived users permanently` });
  } catch (err) {
    console.error("❌ Error deleting all users:", err);
    res.status(500).json({ message: "Server error" });
  }
});

// --- Start Server ---
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));
