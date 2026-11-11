import { Request, Response, NextFunction } from "express";
import { todoRepo } from "../repositories/todoRepository";
import { Todo } from "../models/todo";

export const getTodos = (req: Request, res: Response) => {
  res.json(todoRepo.getAll());
};

export const getTodo = (req: Request, res: Response, next: NextFunction) => {
  const id = Number(req.params.id);
  const todo = todoRepo.getById(id);
  if (!todo) {
    return res.status(404).json({ error: "Todo not found" });
  }
  res.json(todo);
};

export const createTodo = (req: Request, res: Response) => {
  const { text } = req.body;
  if (typeof text !== "string" || !text.trim()) {
    return res.status(400).json({ error: "Invalid text" });
  }
  const todo = todoRepo.create(text.trim());
  res.status(201).json(todo);
};

export const updateTodo = (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const updates = req.body as Partial<Omit<Todo, "id">>;
  const updated = todoRepo.update(id, updates);
  if (!updated) {
    return res.status(404).json({ error: "Todo not found" });
  }
  res.json(updated);
};

export const deleteTodo = (req: Request, res: Response) => {
  const id = Number(req.params.id);
  const success = todoRepo.delete(id);
  if (!success) {
    return res.status(404).json({ error: "Todo not found" });
  }
  res.status(204).send();
};
