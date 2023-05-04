class API {
  constructor() {
    this.test = "TEST";
  }

  async getNASAAPI() {
    const response = await fetch(
      "https://api.nasa.gov/planetary/apod?api_key=Y423QMOn9VCVOVmxkHg1ZTg8x8S3kszz7UHwXYvd"
    );
    console.log("Response Status: ", response.status);
    data = await response.json();
    console.log("CLIENTJS DATA: ", data);
    return data;
  }
}
