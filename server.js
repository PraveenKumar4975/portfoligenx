require("dotenv").config();
const { exec } = require("child_process");
const express = require("express");
const multer = require("multer");
const cors = require("cors");
const fs = require("fs");
const axios = require("axios");
const FormData = require("form-data");
const path = require("path");
const nodemailer = require("nodemailer");
const { log } = require("console");
const { OAuth2Client } = require('google-auth-library');
const jwt = require('jsonwebtoken');
const JWT_SECRET = process.env.JWT_SECRET;


const app = express();
const PORT = 5000;

const API_KEY = process.env.API_KEY;
const OPENROUTER_API_KEY = process.env.OPENROUTER_API_KEY;


app.use(express.json());
const corsOptions = {
  origin: "http://localhost:3000", // Frontend URL
  methods: ["GET", "POST", "PUT", "DELETE"],
  allowedHeaders: ["Content-Type", "Authorization"], // Allow the Authorization header
};

app.use(cors(corsOptions));

app.use(cors());

app.use(express.static("public"));
// Setup Google Client
const client = new OAuth2Client(process.env.GOOGLE_CLIENT_ID);

// Middleware to validate JWT
const verifyToken = (req, res, next) => {
  const token = req.header("Authorization")?.replace("Bearer ", "");
  if (!token) {
    return res.status(401).json({ message: "Access denied. No token provided." });
  }

  try {
    const decoded = jwt.verify(token, JWT_SECRET);
    req.user = decoded; // Attach the decoded user to the request
    next(); // Proceed to the next middleware/route handler
  } catch (err) {
    return res.status(400).json({ message: "Invalid token" });
  }
};
// AUTH ROUTE (POST /auth/google)
// =======================
app.post('/auth/google', async (req, res) => {
  const { token } = req.body;

  try {
    const ticket = await client.verifyIdToken({
      idToken: token,
      audience: process.env.GOOGLE_CLIENT_ID,
    });

    const payload = ticket.getPayload();
    const user = {
      name: payload.name,
      email: payload.email,
      picture: payload.picture,
    };

    // Optional: Restrict to certain users
    // const allowedUsers = ['example@gmail.com']; // Replace with real email(s)
    // if (!allowedUsers.includes(user.email)) {
    //   return res.status(401).json({ success: false, message: "Unauthorized user" });
    // }

    const jwtToken = jwt.sign(user, process.env.JWT_SECRET, { expiresIn: '1h' });

    res.status(200).json({
      success: true,
      token: jwtToken,
      user,
    });
  } catch (error) {
    console.error('Google login error:', error);
    res.status(401).json({ success: false, message: 'Invalid token' });
  }
});

// Middleware to protect routes
// const verifyToken = (req, res, next) => {
//   const authHeader = req.headers['authorization'];
//   console.log("Auth Header:", authHeader);

//   const token = authHeader && authHeader.split(' ')[1];
//   console.log("Extracted Token:", token);

//   if (!token) return res.sendStatus(401);

//   jwt.verify(token, JWT_SECRET, (err, user) => {
//     if (err) {
//       console.log("JWT Error:", err);
//       return res.sendStatus(403);
//     }
//     req.user = user;
//     next();
//   });
// };

// =======================
app.use(cors());

const upload = multer({ dest: "uploads/" });

let storedParsedData = null;

// Utility to clean AI HTML
const cleanHTML = (html) =>
  html
    .replace(/```(html|jsx)?/g, "")
    .replace(/```/g, "")
    .replace(/\\boxed\{/g, "")
    .replace(/\}$/, "")
    .trim();

// Upload + parse resume
app.post("/upload-resume",verifyToken, upload.single("resume"), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: "No file uploaded" });

  try {
    const filePath = `${req.file.path}.pdf`;
    fs.renameSync(req.file.path, filePath);

    const formData = new FormData();
    formData.append("file", fs.createReadStream(filePath));

    const response = await axios.post("https://resumeparser.app/resume/parse", formData, {
      headers: { Authorization: `Bearer ${API_KEY}`, ...formData.getHeaders() },
    });

    fs.unlinkSync(filePath);
    storedParsedData = response.data;
    console.log(storedParsedData);

    res.json({ message: "Resume parsed successfully", parsedData: storedParsedData });
  } catch (err) {
    console.error("❌ Resume parse error:", err.response?.data || err.message);
    res.status(500).json({ error: "Resume parsing failed", details: err.message });
  }
});

// Generate HTML portfolio
app.post("/generate-portfolio", async (req, res) => {
  if (!storedParsedData)
    return res.status(400).json({ error: "No resume data found" });

  const prompt = `Generate a fully responsive and modern personal portfolio website using TailwindCSS via CDN. The website must include smooth scrolling and the following sections: Hero, Skills, Projects, Education, and Contact. The design should be visually elegant with clean layout, professional spacing, and subtle animations.

Use the following resume data to personalize the content:

${JSON.stringify(storedParsedData, null, 2)}

Return only a complete standalone HTML file that starts with <!DOCTYPE html>. 
⚠️ Do NOT include any markdown, triple backticks , code fences, JSX, or explanatory text. Respond with pure HTML only.`;


  try {
    const aiResponse = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "google/gemini-2.0-flash-exp:free",
        messages: [{ role: "user", content: prompt }]
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENROUTER_API_KEY}`,
          "Content-Type": "application/json"
        }
      }
    );

    const html = aiResponse.data.choices[0].message.content;

    const outputPath = path.join(__dirname, "public", "index.html");
    fs.writeFileSync(outputPath, html, "utf8");

    res.json({
      message: "Portfolio generated",
      previewUrl: "http://localhost:5000/index.html"
    });
  } catch (err) {
    console.error("❌ AI generation error:", err.response?.data || err.message);
    res.status(500).json({ error: "AI generation failed", details: err.message });
  }
});

// Preview locally
app.get("/preview-portfolio", (req, res) => {
  const portfolioPath = path.join(__dirname, "public", "index.html");
  if (fs.existsSync(portfolioPath)) {
    res.sendFile(portfolioPath);
  } else {
    res.status(404).send("No generated portfolio found.");
  }
});
// customize hereee...
app.post("/customize-portfolio", async (req, res) => {
  const { userPrompt } = req.body;

  const portfolioPath = path.join(__dirname, "public", "index.html");
  if (!fs.existsSync(portfolioPath)) {
    return res.status(404).json({ error: "No portfolio found to customize." });
  }

  const originalHTML = fs.readFileSync(portfolioPath, "utf8");
//do not change he structure or layout
  const prompt = `
You are a frontend UI expert. 
Apply ONLY the following customization to this HTML:
"${userPrompt}"

Only update things like colors, font, spacing, animations, styles,background etc.

HTML to customize:
${originalHTML}
`;

  try {
    const response = await axios.post(
      "https://openrouter.ai/api/v1/chat/completions",
      {
        model: "google/gemini-2.0-flash-exp:free",
        messages: [{ role: "user", content: prompt }],
      },
      {
        headers: {
          Authorization: `Bearer ${OPENROUTER_API_KEY}`,
          "Content-Type": "application/json",
        },
      }
    );

    const raw = response.data.choices[0].message.content;
    const cleaned = raw
      .replace(/```(html)?/g, "")
      .replace(/```/g, "")
      .replace(/\\boxed\{/g, "")
      .replace(/\}$/g, "")
      .trim();

    fs.writeFileSync(portfolioPath, cleaned, "utf8");

    res.json({ message: "Customization applied", previewUrl: "/preview-portfolio" });
  } catch (error) {
    console.error("Customization error:", error.message);
    res.status(500).json({ error: "Customization failed", details: error.message });
  }
});



// Deploy to Netlify (✅ unique sharable link, NOT production)
app.post("/deploy-portfolio", async (req, res) => {
  const publicDir = path.join(__dirname, "public");
  const deployCommand = `netlify deploy --dir="${publicDir}" --message="Resume-based Portfolio"`;

  exec(deployCommand, (error, stdout, stderr) => {
    if (error) {
      console.error("❌ Netlify deploy error:", error.message);
      return res.status(500).json({ error: "Deployment failed", details: error.message });
    }

    // ✅ Extract unique deploy URL
    const urlMatch = stdout.match(/(https:\/\/[^\s]+\.netlify\.app)/);

    if (!urlMatch) {
      console.error("⚠️ Could not find deploy URL in output.");
      return res.status(500).json({ error: "Deployed, but URL not found" });
    }

    const deployedUrl = urlMatch[1];
    console.log("✅ Deployed at:", deployedUrl);
    res.json({ message: "Deployed successfully", deployedUrl });
  });
});
//se nd the mail
app.post("/send-email", async (req, res) => {
  const { to, deployedURL } = req.body;
  console.log(deployedURL);
  
  try {
    let transporter = nodemailer.createTransport({
      service: "gmail",
      auth: {
        user: "ppb4975@gmail.com",
        pass: "vazd acbu bwxl aszr", // Use App Password if using Gmail
      },
    });

    let info = await transporter.sendMail({
      from: '"Portfolio Bot" <ppb4975@gmail.com>',
      to,
      subject: "🚀 Your Portfolio is Ready!",
      html: `<p>Hi! Your portfolio is live: <a href="${deployedURL}">${deployedURL}</a></p>`,
    });

    res.json({ success: true, message: "Email sent!" });
  } catch (err) {
    console.error(err);
    res.status(500).json({ success: false, message: "Failed to send email." });
  }
});
app.post("/subscribe", async (req, res) => {
  const { email } = req.body;

  const transporter = nodemailer.createTransport({
    service: "gmail",
    auth: {
      user: "ppb4975@gmail.com",
      pass: "vazd acbu bwxl aszr",
    },
  });

  const mailOptions = {
    from: "ppb4975@gmail.com",
    to: email,
    subject: "Welcome to our Newsletter!",
    text: "Thanks for subscribing! We’ll send you updates soon.",
  };

  try {
    await transporter.sendMail(mailOptions);
    res.json({ message: "Subscription successful!" });
  } catch (error) {
    console.error("Error sending email:", error);
    res.status(500).json({ message: "Failed to send email." });
  }
});


// Server start
app.listen(PORT, () => {
  console.log(`✅ Backend running at http://localhost:${PORT}`);
});


