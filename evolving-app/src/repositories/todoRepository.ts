import { Todo } from "../models/todo";

let todos: Todo[] = [];
let nextId = 1;

export const todoRepo = {
  getAll(): Todo[] {
    return [...todos];
  },
  getById(id: number): Todo | undefined {
    return todos.find(t => t.id === id);
  },
  create(text: string): Todo {
    const todo: Todo = { id: nextId++, text, completed: false };
    todos.push(todo);
    return todo;
  },
  update(id: number, updates: Partial<Omit<Todo, "id">>): Todo | undefined {
    const todo = todos.find(t => t.id === id);
    if (!todo) return undefined;
    Object.assign(todo, updates);
    return todo;
  },
  delete(id: number): boolean {
    const index = todos.findIndex(t => t.id === id);
    if (index === -1) return false;
    todos.splice(index, 1);
    return true;
  }
};
