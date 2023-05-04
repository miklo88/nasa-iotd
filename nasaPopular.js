class NASAPopular {
  constructor() {
    this.response = [];
  }

  async nasaPopularList() {
    const response = await fetch("https://images-assets.nasa.gov/popular.json");
    console.log("Response Status: ", response.status);
    data = await response.json();
    console.log("nasaPopularList DATA: ", data);
    return data;
  }
}
//clean up the response object here.
//then deliver it to the nasaView.js file to render and set state.
//could set state here as well.
