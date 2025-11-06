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

const app = express();``
const PORT = process.env.PORT || 3000;

// --- File Paths ---
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

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
app.use(express.static("public"));



// --- Ensure directories exist ---
const dbDir = path.join(__dirname, "db");
const uploadsDir = path.join(__dirname, "uploads");
const lessonsDir = path.join(uploadsDir, "lessons");
const handoutsDir = path.join(lessonsDir, "handouts");
const powerpointsDir = path.join(lessonsDir, "powerpoints");
const videosDir = path.join(lessonsDir, "videos");
const coursesDir = path.join(uploadsDir, "courses");
const assessmentsDir = path.join(uploadsDir, "assessments");

// Create all directories if missing
[
  dbDir,
  uploadsDir,
  lessonsDir,
  handoutsDir,
  powerpointsDir,
  videosDir,
  coursesDir,
  assessmentsDir
].forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

// --- Serve uploads statically ---
app.use("/uploads", express.static(uploadsDir));

// --- Multer File Upload Setup ---
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();

    // Handouts (PDF, DOC, DOCX)
    if ([".pdf", ".doc", ".docx"].includes(ext)) {
      cb(null, handoutsDir);
    }
    // PowerPoints
    else if ([".ppt", ".pptx"].includes(ext)) {
      cb(null, powerpointsDir);
    }
    // Videos
    else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
      cb(null, videosDir);
    }
    // Default to lessons root if type unknown
    else {
      cb(null, lessonsDir);
    }
  },

  filename: (req, file, cb) => {
    const uniqueName = `${Date.now()}-${file.originalname}`;
    cb(null, uniqueName);
  }
});

// Allow multiple files (array under `lessonFiles`)
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


// === PROGRESS TRACKING SYSTEM ===============================================================

db.data.progress ||= [];
await db.write();

app.get("/api/progress/:userId/:courseId", async (req, res) => {
  try {
    await db.read();
    const { userId, courseId } = req.params;

    // Find all lessons + assessments for this course
    const totalLessons = db.data.lessons.filter(l => String(l.courseId) === String(courseId)).length;
    const totalAssessments = db.data.assessments.filter(a => String(a.courseId) === String(courseId)).length;
    const totalItems = totalLessons + totalAssessments;

    // Find user progress record (or create if missing)
    let progress = db.data.progress.find(
      p => p.userId === userId && String(p.courseId) === String(courseId)
    );

    if (!progress) {
      progress = {
        id: Date.now(),
        userId,
        courseId,
        openedLessons: [],
        openedAssessments: [],
        completionRate: 0,
        lastUpdated: new Date().toISOString(),
      };
      db.data.progress.push(progress);
    }

    // Recalculate percentage
    const openedCount = (progress.openedLessons.length + progress.openedAssessments.length);
    const completionRate = totalItems > 0 ? Math.round((openedCount / totalItems) * 100) : 0;

    progress.completionRate = completionRate;
    progress.lastUpdated = new Date().toISOString();

    await db.write();
    res.json({ success: true, progress });
  } catch (err) {
    console.error("❌ Error fetching progress:", err);
    res.status(500).json({ success: false, message: "Error fetching progress." });
  }
});

/**
 * Mark a lesson or assessment as opened → updates progress
 */
app.post("/api/progress/update", async (req, res) => {
  try {
    await db.read();
    db.data.progress ||= [];

    const { userId, courseId, lessonId, assessmentId } = req.body;
    if (!userId || !courseId)
      return res.status(400).json({ success: false, message: "userId and courseId required." });

    // Find or create record
    let progress = db.data.progress.find(
      p => p.userId === userId && String(p.courseId) === String(courseId)
    );
    if (!progress) {
      progress = {
        id: Date.now(),
        userId,
        courseId,
        openedLessons: [],
        openedAssessments: [],
        completionRate: 0,
        lastUpdated: new Date().toISOString(),
      };
      db.data.progress.push(progress);
    }

    // Track lesson or assessment
    if (lessonId && !progress.openedLessons.includes(lessonId)) {
      progress.openedLessons.push(lessonId);
    }
    if (assessmentId && !progress.openedAssessments.includes(assessmentId)) {
      progress.openedAssessments.push(assessmentId);
    }

    // Recalculate
    const totalLessons = db.data.lessons.filter(l => String(l.courseId) === String(courseId)).length;
    const totalAssessments = db.data.assessments.filter(a => String(a.courseId) === String(courseId)).length;
    const totalItems = totalLessons + totalAssessments;
    const openedCount = (progress.openedLessons.length + progress.openedAssessments.length);
    progress.completionRate = totalItems > 0 ? Math.round((openedCount / totalItems) * 100) : 0;
    progress.lastUpdated = new Date().toISOString();

    await db.write();
    res.json({ success: true, progress });
  } catch (err) {
    console.error("Error updating progress:", err);
    res.status(500).json({ success: false, message: "Error updating progress." });
  }
});

// === GET ALL COURSES WITH PROGRESS FOR DASHBOARD =====================
app.get("/api/trainee/:userId/courses", (req, res) => {
  const userId = req.params.userId;

  // Find all assigned courses for that trainee
  const assignedCourses = db.assigned.filter(a => a.userId === userId);

  // For each assigned course, find full course details
  const traineeCourses = assignedCourses.map(assign => {
    const course = db.courses.find(c => c.id === assign.courseId);
    if (!course) return null;
    return {
      id: course.id,
      title: course.title,
      description: course.description,
      image: course.image || "default-course.jpg",
      instructor: db.users.find(u => u.userId === course.uploadedBy)?.fullName || "Unknown Instructor",
      completionRate: assign.progress ? parseInt(assign.progress) : 0
    };
  }).filter(Boolean);

  res.json({
    success: true,
    courses: traineeCourses
  });
});


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
// === GET Courses for a specific trainee ///////////////////////////////////////////////////////////////////
app.get("/api/courses/:userId", async (req, res) => {
  try {
    await db.read();
    const { userId } = req.params;

    // { courseId, title, description, assignedTo: ["T1234", "T5678"], ... }
    const traineeCourses = db.data.courses.filter(course =>
      Array.isArray(course.assignedTo) && course.assignedTo.includes(userId)
    );

    res.json(traineeCourses);
  } catch (err) {
    console.error("Error fetching trainee courses:", err);
    res.status(500).json({ message: "Server error fetching trainee courses." });
  }
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

// GET specific lesson by ID
app.get("/api/lessons/:id", async (req, res) => {
  await db.read();
  const lesson = db.data.lessons.find(l => String(l.id) === req.params.id);
  if (!lesson) return res.status(404).json({ message: "Lesson not found" });
  res.json(lesson);
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
    const archivedUsers = db.data.users.filter(u => u.status === "Archived");
    res.json(archivedUsers);
  } catch (err) {
    console.error("Error fetching archived users:", err);
    res.status(500).json({ message: "Server error." });
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
  try {
    const { courseTitle, courseDesc, userID } = req.body;

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
      uploadedBy: userID || "S1234", // fallback for safety
      status: "Active"
    };

    // 💾 4️⃣ Save to DB
    await db.read();
    db.data.courses.push(newCourse);
    await db.write();

    console.log("✅ New course added:", newCourse);

    // 📤 5️⃣ Respond with success
    res.json({ message: "Course created successfully", course: newCourse });
  } catch (err) {
    console.error("❌ Error creating course:", err);
    res.status(500).json({ message: "Server error creating course." });
  }
});

// LESSONS
app.post("/api/lessons", upload.array("lessonFiles"), async (req, res) => {
  try {
    const { lessonTitle, lessonCourse, lessonDesc, uploadedBy } = req.body;

    if (!req.files || req.files.length === 0)
      return res.status(400).json({ message: "No files uploaded." });

    const courseId = parseInt(lessonCourse);
    if (isNaN(courseId))
      return res.status(400).json({ message: "Invalid or missing course ID." });

    // --- Ensure subfolders exist ---
    const handoutsDir = path.join(uploadsDir, "lessons", "handouts");
    const powerpointsDir = path.join(uploadsDir, "lessons", "powerpoints");
    const videosDir = path.join(uploadsDir, "lessons", "videos");
    [handoutsDir, powerpointsDir, videosDir].forEach(dir => {
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    });

    // --- Categorize uploaded files ---
    const handouts = [];
    const powerpoints = [];
    const videos = [];

    req.files.forEach(file => {
      const ext = path.extname(file.originalname).toLowerCase();
      const newFilename = `${Date.now()}-${file.originalname}`;

      if ([".pdf", ".doc", ".docx"].includes(ext)) {
        const newPath = path.join(handoutsDir, newFilename);
        fs.renameSync(file.path, newPath);
        handouts.push(`/uploads/lessons/handouts/${newFilename}`);
      } else if ([".ppt", ".pptx"].includes(ext)) {
        const newPath = path.join(powerpointsDir, newFilename);
        fs.renameSync(file.path, newPath);
        powerpoints.push(`/uploads/lessons/powerpoints/${newFilename}`);
      } else if ([".mp4", ".mov", ".avi", ".mkv"].includes(ext)) {
        const newPath = path.join(videosDir, newFilename);
        fs.renameSync(file.path, newPath);
        videos.push(`/uploads/lessons/videos/${newFilename}`);
      } else {
        // any uncategorized files remain in the default /uploads/lessons
        console.warn("Unrecognized file type:", file.originalname);
      }
    });

    // --- Build lesson object exactly like your db.json structure ---
    const newLesson = {
      id: Date.now(),
      title: lessonTitle?.trim() || "Untitled Lesson",
      description: lessonDesc?.trim() || "",
      courseId,
      content: {
        handout: handouts[0] || null, // single main file if any
        videos,
        powerpoints,
      },
      uploadedBy: uploadedBy || "S1234",
      uploadedAt: new Date().toISOString(),
    };

    // --- Save to database ---
    await db.read();
    db.data.lessons.push(newLesson);
    await db.write();

    console.log("✅ New lesson added:", newLesson);
    res.json({ message: "Lesson added successfully", lesson: newLesson });

  } catch (err) {
    console.error("❌ Error adding lesson:", err);
    res.status(500).json({ message: "Server error adding lesson." });
  }
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

    const {
      title,
      type,
      difficulty,
      courseId,
      lessonId,
      duration,
      deadline,
      questions,
    } = req.body;

    // --- Validate ---
    if (!title || !type || !difficulty || !courseId || !lessonId) {
      return res.status(400).json({ success: false, error: "Missing required fields." });
    }

    // --- Build new assessment ---
    const newAssessment = {
      id: Date.now(),
      title: title.trim(),
      type,
      difficulty,
      courseId: Number(courseId),
      lessonId: Number(lessonId),
      duration: duration || null,
      deadline: deadline || null,
      questions: Array.isArray(questions) ? questions : [],
      createdAt: new Date().toISOString(),
    };

    // --- Save to DB ---
    db.data.assessments.push(newAssessment);
    await db.write();

    // --- Save to /uploads/assessments as individual file ---
    const safeTitle = (newAssessment.title || `assessment-${newAssessment.id}`)
      .replace(/[^\w\s-]/g, "_")
      .replace(/\s+/g, "_")
      .trim();
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${safeTitle}_${timestamp}.json`;
    const filePath = path.join(assessmentsDir, filename);

    fs.writeFileSync(filePath, JSON.stringify({ assessments: [newAssessment] }, null, 2));

    console.log(`✅ Created assessment "${newAssessment.title}"`);
    console.log(`📁 Saved to: ${filePath}`);

    res.json({
      success: true,
      message: "✅ Assessment created successfully!",
      assessment: newAssessment,
      file: `/uploads/assessments/${filename}`,
    });
  } catch (err) {
    console.error("❌ Error creating assessment:", err);
    res.status(500).json({ success: false, error: "Server error while creating assessment." });
  }
});

// ADD QUESTION TO EXISTING ASSESSMENT
app.post("/api/questions", upload.none(), async (req, res) => {
  try {
    await db.read();
    db.data.assessments ||= [];

    const {
      assessmentId,
      questionNumber,
      questionType,
      question,
      options,
      answer,
      expectedAnswer,
      points,
    } = req.body;

    // --- Find assessment ---
    const assessment = db.data.assessments.find(a => a.id == assessmentId);
    if (!assessment) {
      return res.status(404).json({ success: false, error: "Assessment not found." });
    }

    // --- Build question object ---
    const newQuestion = {
      id: Date.now(),
      questionNumber: Number(questionNumber) || assessment.questions.length + 1,
      questionType,
      question,
      options: questionType === "mcq" ? JSON.parse(options || "[]") : [],
      answer: questionType === "mcq" ? answer : null,
      expectedAnswer: questionType === "textbox" || questionType === "code" ? expectedAnswer : null,
      points: parseInt(points, 10) || 0,
    };

    // --- Add to assessment ---
    assessment.questions.push(newQuestion);
    await db.write();

    // --- Save updated assessment to file ---
    const safeTitle = (assessment.title || `assessment-${assessment.id}`)
      .replace(/[^\w\s-]/g, "_")
      .replace(/\s+/g, "_")
      .trim();

    const filePath = path.join(assessmentsDir, `${safeTitle}.json`);
    fs.writeFileSync(filePath, JSON.stringify({ assessments: [assessment] }, null, 2));

    console.log(`✅ Added question #${newQuestion.questionNumber} to "${assessment.title}"`);
    console.log(`📁 Updated file: ${filePath}`);

    res.json({
      success: true,
      message: `Question ${newQuestion.questionNumber} added successfully`,
      question: newQuestion,
      assessment,
    });
  } catch (err) {
    console.error("❌ Error adding question:", err);
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
// --- Add New User (Improved) ---
app.post("/api/users/add", async (req, res) => {
  try {
    await db.read();
    db.data.users ||= [];

    const { fullName, userType, email, password } = req.body;

    // Validate input
    if (!fullName || !userType || !email || !password) {
      return res.status(400).json({
        success: false,
        message: "All fields are required (fullName, userType, email, password).",
      });
    }

    // Check duplicate email
    const existingUser = db.data.users.find(
      (u) => u.email.toLowerCase() === email.toLowerCase()
    );
    if (existingUser) {
      return res.status(409).json({
        success: false,
        message: "Email already registered.",
      });
    }

    // Generate unique userId
    const prefix =
      userType === "SME" ? "S" :
      userType === "Admin" ? "A" :
      userType === "Trainee" ? "T" :
    "";

    let userId;
    do {
      userId = `${prefix}${Math.floor(1000 + Math.random() * 9000)}`;
    } while (db.data.users.some(u => u.userId === userId));

    // Hash password securely
    const hashedPassword = await bcrypt.hash(password, 10);

    // Create user object
    const newUser = {
      id: Date.now(),
      userId,
      fullName: fullName.trim(),
      userType,
      email: email.trim().toLowerCase(),
      password: hashedPassword,
      createdAt: new Date().toISOString(),
      status: "Active",
      dateArchived: ""
    };

    // Save to DB
    db.data.users.push(newUser);
    await db.write();

    // Return success (hide password)
    const { password: _, ...safeUser } = newUser;
    res.status(201).json({
      success: true,
      message: "✅ User added successfully!",
      user: safeUser,
    });
  } catch (err) {
    console.error("❌ Error adding user:", err);
    res.status(500).json({
      success: false,
      message: "Server error while adding user.",
      error: err.message,
    });
  }
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
      return res.status(404).json({ message: "User not found." });

    if (user.status === "Archived")
      return res.status(400).json({ message: "User is already archived." });

    user.status = "Archived";
    user.dateArchived = new Date().toISOString();
    await db.write();

    res.json({ message: `✅ User ${userId} archived successfully.`, user });
  } catch (err) {
    console.error("Error archiving user:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// PATCH Restore user
app.patch("/api/archived-users/restore/:id", async (req, res) => {
  try {
    await db.read();
    const userId = req.params.id;
    const user = db.data.users.find(u => u.userId === userId);

    if (!user)
      return res.status(404).json({ message: "User not found." });

    if (user.status !== "Archived")
      return res.status(400).json({ message: "User is not archived." });

    user.status = "Active";
    user.dateArchived = "";
    await db.write();

    res.json({ message: `✅ User ${userId} restored successfully.`, user });
  } catch (err) {
    console.error("Error restoring user:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// RESTORE ALL
app.patch("/api/archived-users/restore-all", async (req, res) => {
  try {
    await db.read();
    db.data.users.forEach(u => {
      if (u.status === "Archived") {
        u.status = "Active";
        u.dateArchived = "";
      }
    });
    await db.write();
    res.json({ message: "✅ All archived users restored successfully." });
  } catch (err) {
    console.error("Error restoring all users:", err);
    res.status(500).json({ message: "Server error." });
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
    const userId = req.params.id;
    const index = db.data.users.findIndex(u => u.userId === userId && u.status === "Archived");

    if (index === -1)
      return res.status(404).json({ message: "Archived user not found." });

    db.data.users.splice(index, 1);
    await db.write();

    res.json({ message: `🗑️ Archived user ${userId} deleted permanently.` });
  } catch (err) {
    console.error("Error deleting archived user:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// DELETE ALL
app.delete("/api/archived-users/delete-all", async (req, res) => {
  try {
    await db.read();
    db.data.users = db.data.users.filter(u => u.status !== "Archived");
    await db.write();
    res.json({ message: "🗑️ All archived users deleted permanently." });
  } catch (err) {
    console.error("Error deleting all archived users:", err);
    res.status(500).json({ message: "Server error." });
  }
});

// Serve all static files from "public"
app.use(express.static("public"));

// --- LESSON ROUTE ---
app.get("/lesson/:lessonId", async (req, res) => {
  const lessonId = Number(req.params.lessonId);
  await db.read();

  const lesson = db.data.lessons.find((l) => l.id === lessonId);
  if (!lesson) {
    console.log("Lesson not found for ID:", lessonId);
    return res.status(404).send("Lesson not found");
  }

  const templatePath = path.join(__dirname, "templates", "lesson-template.html");
  const outputDir = path.join(__dirname, "public", "lessons");
  const outputFile = path.join(outputDir, `${lessonId}.html`);

  if (!fs.existsSync(outputDir)) fs.mkdirSync(outputDir, { recursive: true });

  let html = fs.readFileSync(templatePath, "utf8");
  html = html
    .replace(/{{lessonTitle}}/g, lesson.title)
    .replace(/{{lessonDescription}}/g, lesson.description)
    .replace(/{{lessonHandout}}/g, lesson.content?.handout || "None")
    .replace(/{{lessonVideos}}/g, lesson.content?.videos?.join(", ") || "None")
    .replace(/{{lessonPowerpoints}}/g, lesson.content?.powerpoints?.join(", ") || "None");

  fs.writeFileSync(outputFile, html);
  res.sendFile(outputFile);
});

// ASSESSMENT ROUTE




// --- Start Server ---
app.listen(PORT, () => console.log(`✅ Server running on port ${PORT}`));




