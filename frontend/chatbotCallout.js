// const data = `[{"time_object":{"timestamp":"2024-03-18","duration":1,"duration_unit":"day","timezone":"GMT+11"},"event_type":"stock ohlc","attribute":{"open":272.83,"high":273.65,"low":271.47,"close":271.97,"volume":3319400,"ticker":"MCD","date":"2024-03-18"}}`;

const payload = {
  "data": "nothing",
  "prompt": "say hi!",
};

fetch("https://w8j6waksl3.execute-api.us-east-1.amazonaws.com/dev/chatbot", {
  method: "POST",
  headers: {
    "Content-Type": "application/json",
    "x-api-key": "fbQnzvJZV17BW8VCN1ZHZ4H3sVABx5ht4mleYswv",
  },
  body: JSON.stringify(payload),
})
  .then((response) => {
    if (!response.ok) {
      throw new Error(`HTTP error! Status: ${response.status}`);
    }
    return response.json();
  })
  .then((response) => {
    console.log("Response from Lambda:", response);
  })
  .catch((error) => {
    console.log(error);
  });
