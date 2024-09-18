const tstr = '{email:"1O5FUuL2gq673kiuqclJwn4ZqbU4ggM5XEcy-1hMrPXc",landing_page:"1O5FUuL2gq673kiuqclJwn4ZqbU4ggM5XEcy-1hMrPXc",journey_builder:"1O5FUuL2gq673kiuqclJwn4ZqbU4ggM5XEcy-1hMrPXc",custom:"1O5FUuL2gq673kiuqclJwn4ZqbU4ggM5XEcy-1hMrPXc"}'

const templates = JSON.parse(
    tstr.replace(/(\w+):/g, '"$1":').replace(/'/g, '"')
  );
  
  const capitalizeWords = (str) => {
    return str.replace(/_/g, ' ').replace(/\b\w/g, char => char.toUpperCase());
  };
  
  const qa_type_select_values = Object.keys(templates).map(key => ({
    text: {
      type: "plain_text",
      text: capitalizeWords(key),  // Capitalize each word in the key
    },
    value: key,  // Use the original key as the value
  }));
  
  console.log(qa_type_select_values);
  