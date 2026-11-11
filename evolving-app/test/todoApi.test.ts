import request from "supertest";
import express from "express";
import todoRoutes from "../src/routes/todoRoutes";

const app = express();
app.use(express.json());
app.use("/api/todos", todoRoutes);

describe("Todo API", () => {
  let createdId: number;

  it("creates a todo", async () => {
    const res = await request(app).post("/api/todos").send({ text: "Test Todo" });
    expect(res.status).toBe(201);
    expect(res.body).toHaveProperty("id");
    createdId = res.body.id;
  });

  it("gets todos list", async () => {
    const res = await request(app).get("/api/todos");
    expect(res.status).toBe(200);
    expect(Array.isArray(res.body)).toBe(true);
  });

  it("toggles completed", async () => {
    const getRes = await request(app).get(`/api/todos/${createdId}`);
    const completed = getRes.body.completed;
    const res = await request(app).put(`/api/todos/${createdId}`).send({ completed: !completed });
    expect(res.status).toBe(200);
    expect(res.body.completed).toBe(!completed);
  });

  it("deletes todo", async () => {
    const res = await request(app).delete(`/api/todos/${createdId}`);
    expect(res.status).toBe(204);
  });
});
