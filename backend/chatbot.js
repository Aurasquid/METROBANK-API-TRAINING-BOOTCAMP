import OpenAI from "openai";
import fs from "fs";
import dotenv from "dotenv";

dotenv.config();

// --- Initialize OpenAI client ---
const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY
});

// --- Handle incoming chat messages ---
export async function handleChat(message) {
  if (!message || typeof message !== "string") {
    return "Invalid message input.";
  }

  // Optional: load a knowledge base file if available
  let knowledge = "";
  try {
    knowledge = fs.readFileSync("api.knowledge.txt", "utf-8");
  } catch {
    console.warn("[Notice] No knowledge base file found. Continuing without it.");
  }

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-3.5-turbo",
      messages: [
        { role: "system", content: `You are a helpful assistant. Knowledge base: ${knowledge}` },
        { role: "user", content: message }
      ]
    });

    // Safely return the assistant’s reply
    return completion.choices?.[0]?.message?.content?.trim() || "No response generated.";
  } catch (error) {
    console.error("[OpenAI API Error]", error);
    return "Error: Unable to get a response from OpenAI.";
  }
}
