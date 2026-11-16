# Thesis - Point Cloud to NURBS Surface Tool
A web app that turns structured point-cloud text files (for example from MRI or CT scans) into NURBS surfaces. You can fit surfaces by approximation or interpolation, change the number of patches, compare the two fits, and ask an AI assistant about the results.

## What's in the project

- `frontend/` - React and Three.js interface
- `backend/surface_approx.py` - Flask server that fits the surfaces (port 5000)
- `backend/chatbot.py` - Flask server for the AI assistant (port 5001)

## Requirements

- Python 3.9 or newer
- Node.js and npm
- An OpenAI API key (only needed for the AI assistant)

## Setup

### 1. Backend

```
cd backend
python3 -m pip install -r requirements.txt
```

On Windows, use `python` or `py` instead of `python3`.

### 2. OpenAI key

Copy `.env.example` to a new file called `.env`, then open it and replace `your-key-here` with your own key:

```
OPENAI_API_KEY=your-key-here
```

### 3. Frontend

```
cd frontend
npm install
```

## Running the app

Use three terminals.

**Terminal 1 - surface fitting server**
```
cd backend
python3 app.py
```

**Terminal 2 - AI assistant server**
```
cd backend
python3 chatbot.py
```

**Terminal 3 - frontend**
```
cd frontend
npm run dev
```

Then open the address the frontend prints (usually http://localhost:5173).

## Input file format

One point per line as `x,y,z` (commas, spaces, tabs or semicolons all work). Points must form a grid listed row by row.

Alternatively, the following format will also work:

To state a patch's grid size, start it with a marker line:

```
# PATCH size_u=5 size_v=7
```

Files without markers are split into rows automatically where possible. Files exported from this app can be loaded back in.
