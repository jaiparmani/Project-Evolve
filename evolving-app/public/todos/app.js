// Todo List client‑side logic using the server API

const API_URL = "/api/todos";

/** Fetch all todos from the server */
async function loadTodos() {
  const res = await fetch(API_URL);
  if (!res.ok) throw new Error("Failed to load todos");
  return await res.json();
}

/** Render the todo list */
async function renderTodos() {
  const listEl = document.getElementById("todo-list");
  listEl.innerHTML = "";
  try {
    const todos = await loadTodos();
    todos.forEach((todo) => {
      const li = document.createElement("li");
      li.setAttribute("role", "listitem");
      if (todo.completed) li.classList.add("completed");

      const span = document.createElement("span");
      span.textContent = todo.text;
      span.tabIndex = 0;
      span.addEventListener("click", () => toggleTodo(todo.id));
      span.addEventListener("keypress", (e) => {
        if (e.key === "Enter" || e.key === " ") toggleTodo(todo.id);
      });

      const delBtn = document.createElement("button");
      delBtn.textContent = "Delete";
      delBtn.setAttribute("aria-label", `Delete todo ${todo.text}`);
      delBtn.addEventListener("click", () => deleteTodo(todo.id));

      li.appendChild(span);
      li.appendChild(delBtn);
      listEl.appendChild(li);
    });
  } catch (err) {
    console.error(err);
    listEl.innerHTML = "<li>Error loading todos</li>";
  }
}

/** Add a new todo via POST */
async function addTodo(text) {
  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ text })
  });
  if (!res.ok) throw new Error("Failed to add todo");
  await renderTodos();
}

/** Delete a todo via DELETE */
async function deleteTodo(id) {
  const res = await fetch(`${API_URL}/${id}`, { method: "DELETE" });
  if (!res.ok && res.status !== 204) throw new Error("Failed to delete todo");
  await renderTodos();
}

/** Toggle completed state via PUT */
async function toggleTodo(id) {
  // Retrieve current state
  const getRes = await fetch(`${API_URL}/${id}`);
  if (!getRes.ok) throw new Error("Failed to fetch todo");
  const todo = await getRes.json();

  const res = await fetch(`${API_URL}/${id}`, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ completed: !todo.completed })
  });
  if (!res.ok) throw new Error("Failed to toggle todo");
  await renderTodos();
}

// Initial render
renderTodos();
